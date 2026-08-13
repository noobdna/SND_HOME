// alerts/ruleEvaluator.js
// ルール評価の状態機械(state machine)ロジック。純粋関数のみで構成し、I/O を持たない
// (テストしやすさを優先 — PHASE5_PLAN.md の「File Structure」参照)。
// 状態遷移の詳細仕様は PHASE5_PLAN.md の「State Machine」セクションを参照。

const STATES = Object.freeze({
  OK: "OK",
  FIRING: "FIRING",
  DOWN: "DOWN",
  RECOVERING: "RECOVERING",
});

/**
 * ルール1件分の初期ランタイム状態を返す。
 * ランタイム状態はルール「定義」(RuleStore が持つ設定)とは別物で、AlertEngine が
 * ルールIDごとにメモリ上でのみ保持する(再起動で消えてよい — PHASE5_PLAN.md の
 * 「Duration」「Hysteresis」「Cooldown」「Duplicate Suppression」参照)。
 * @returns {{
 *   state: string,
 *   breachSince: number|null,
 *   clearSince: number|null,
 *   lastNotifiedAt: number|null,
 *   alertId: string|null,
 * }}
 */
function createInitialState() {
  return {
    state: STATES.OK,
    breachSince: null,
    clearSince: null,
    lastNotifiedAt: null,
    alertId: null,
  };
}

/**
 * ドットパス表記(例: "disk.percent")でスナップショットから値を取り出す。
 * 途中のプロパティが存在しない場合や snapshot / 中間値が null・undefined の場合も
 * 例外を投げず undefined を返す — 「データなし」として扱われ、その回の評価は
 * スキップされる(PHASE5_PLAN.md の Threshold Rules 「metric」欄を参照)。
 * @param {object} snapshot
 * @param {string} metricPath
 * @returns {*} 解決した値、または undefined(未検出/型不正)
 */
function resolveMetric(snapshot, metricPath) {
  if (typeof metricPath !== "string" || metricPath === "") {
    return undefined;
  }

  let current = snapshot;
  for (const key of metricPath.split(".")) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/**
 * value と threshold を operator で比較する。
 * "==" / "!=" は厳密等価(===/!==)で判定する — メトリクス値は数値である前提のため、
 * 型強制による意図しない一致(例: "90" == 90)を避ける。
 *
 * value が undefined(未検出メトリクス)の場合は operator に関わらず常に false
 * (非ブリーチ)を返す — 呼び出し元(alertEngine.handleUpdate())が「データなし」
 * としてそのティックの評価自体をスキップする設計(resolveMetric の JSDoc、
 * PHASE5_PLAN.md の Threshold Rules「metric」欄)への最後の砦として、この関数
 * 自体もその不変条件を保証する。この明示チェックが無くても ">"/">="/"<"/"<="/"=="
 * は元々 undefined を非ブリーチとして扱っていた(NaNとの比較・厳密不等価の帰結)
 * が、"!=" だけは `undefined !== threshold` が常に true になるため唯一の例外
 * だった — PHASE5_PLAN.md Task 2.9 で「known gap」としてテストに明記・ユーザーへ
 * 報告した上で、当時は tests-only スコープのため未修正のまま残されていた
 * (fix自体はこの1行)。
 * @param {number} value
 * @param {">"|">="|"<"|"<="|"=="|"!="} operator
 * @param {number} threshold
 * @returns {boolean}
 * @throws {Error} operator が未知の場合(RuleStore の validateRule() が事前に
 *   ALLOWED_OPERATORS で弾いているため、通常到達しない)
 */
function compare(value, operator, threshold) {
  if (value === undefined) {
    return false;
  }

  switch (operator) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    case "==":
      return value === threshold;
    case "!=":
      return value !== threshold;
    default:
      throw new Error(`Unknown operator: ${operator}`);
  }
}

/**
 * `state.state === STATES.OK` から始まる1ティック分の評価(Task 2.4)。
 *   - OK → OK(非ブリーチ、breachSince をリセット)
 *   - OK → OK(ブリーチ中だが `duration` 秒未満、breachSince を内部トラッキング)
 *   - OK → FIRING(`duration` 秒以上ブリーチが継続 — 通知あり)
 * @returns {{ nextState: object, notify: boolean, alert?: object }}
 */
function evaluateFromOk(rule, value, state, now) {
  const breached = compare(value, rule.operator, rule.threshold);

  if (!breached) {
    return {
      nextState: { ...state, breachSince: null },
      notify: false,
    };
  }

  // 最初にブリーチを検知したティックで breachSince を刻む。以降のティックでは
  // 既存の breachSince を引き継ぎ、継続時間を計測する(PHASE5_PLAN.md「Duration」節)。
  const breachSince = state.breachSince ?? now;
  const durationMs = rule.duration * 1000;

  if (now - breachSince < durationMs) {
    return {
      nextState: { ...state, breachSince },
      notify: false,
    };
  }

  const incidentStartedAt = new Date(now).toISOString();
  const alertId = `${rule.id}:${incidentStartedAt}`;

  const nextState = {
    state: STATES.FIRING,
    breachSince,
    clearSince: null,
    lastNotifiedAt: now,
    alertId,
  };

  const alert = {
    alertId,
    ruleId: rule.id,
    ruleName: rule.name,
    metric: rule.metric,
    value,
    operator: rule.operator,
    threshold: rule.threshold,
    severity: rule.severity,
    state: STATES.FIRING,
    previousState: STATES.OK,
    message: `${rule.name} is FIRING: ${rule.metric} = ${value} (threshold ${rule.operator} ${rule.threshold})`,
    timestamp: incidentStartedAt,
  };

  return { nextState, notify: true, alert };
}

/**
 * `rule.operator`/`rule.threshold` によるブリーチ判定が false になったティックで、
 * `FIRING`/`DOWN` からどこへ抜けるかを決める共通ロジック(Task 2.7)。
 * PHASE5_PLAN.md「State Machine」の Transition table における `DOWN → RECOVERING` ガード
 * ("Metric drops below clearThreshold") をそのまま実装している。
 *
 * `threshold` と `clearThreshold` の間には意図的な「デッドゾーン」が存在しうる
 * (「why hysteresis uses a separate clearThreshold」節 — 例: しきい値 85% に対し
 * clearThreshold 80% の場合、84% はもうブリーチしていないが「回復」とも言えない)。
 * このデッドゾーンにいる間は `RECOVERING` に入らず `DOWN` に留まる — clearThreshold を
 * 割り込むまでは回復が確定しないため(Transition table: "none — recovery isn't
 * confirmed yet")。`clearThreshold` が未設定で `threshold` と同値の場合(帯域なし)は
 * デッドゾーンが消失し、ブリーチしていない ⇔ クリア、が完全に一致する。
 *
 * クリア判定は `compare(value, operator, threshold)` の否定と同じパターンで、
 * `threshold` の代わりに `clearThreshold` を渡し、結果を反転させる形で行う
 * (`operator` が `>=` なら「clear」は `value < clearThreshold`、`operator` が `>` なら
 * 「clear」は `value <= clearThreshold` — De Morgan の関係で `compare()` を再利用できる)。
 *
 * @returns {{ nextState: object, notify: boolean }} 通知は発生しない
 *   (`DOWN → RECOVERING` は「回復未確定」、デッドゾーン残留は状態遷移そのものがない)
 */
function resolveAfterBreachClears(rule, value, state, now) {
  const clear = !compare(value, rule.operator, rule.clearThreshold);

  if (!clear) {
    // デッドゾーン: しきい値は下回ったが clearThreshold はまだ下回っていない → DOWN 継続。
    return {
      nextState: { ...state, state: STATES.DOWN, clearSince: null },
      notify: false,
    };
  }

  // 最初にクリアを検知したティックで clearSince を刻む(breachSince と対称の扱い —
  // PHASE5_PLAN.md「Hysteresis」節)。DOWN→RECOVERING・FIRING→RECOVERING いずれの
  // 呼び出し元でも、このティックが「クリアの起点」になる。
  return {
    nextState: { ...state, state: STATES.RECOVERING, clearSince: now },
    notify: false,
  };
}

/**
 * `state.state === STATES.FIRING` から始まる1ティック分の評価(Task 2.5、Task 2.7 で拡張)。
 *   - まだブリーチ継続中 → `DOWN`(通知なし — `OK → FIRING` 時に送出済み。「1ティックだけ
 *     存在するエッジ状態」の定義通り)
 *   - このティックで既にブリーチが解消 → `resolveAfterBreachClears` に委譲
 *     (`DOWN` に一度も滞在せず `RECOVERING`/`DOWN` へ直行しうる。state diagram 上に
 *     `FIRING → RECOVERING` の矢印は無いが、Task 2.5 のコミット時点でこのケースは
 *     「Task 2.6-2.7 で解禁予定」と明記して未対応にしていた。Task 2.6 は `DOWN` 側の
 *     スコープだったため、この約束を果たすのは Task 2.7 の役目 — `DOWN` に一瞬でも
 *     滞在させてから同じティックでまた抜けるという無意味な中間状態を作るより、
 *     `resolveAfterBreachClears` の判定をそのまま適用するほうが一貫している)
 * @returns {{ nextState: object, notify: boolean, alert?: object }}
 */
function evaluateFromFiring(rule, value, state, now) {
  const breached = compare(value, rule.operator, rule.threshold);

  if (!breached) {
    return resolveAfterBreachClears(rule, value, state, now);
  }

  return {
    nextState: { ...state, state: STATES.DOWN, clearSince: null },
    notify: false,
  };
}

/**
 * `state.state === STATES.DOWN` から始まる1ティック分の評価(Task 2.6)。
 * `DOWN` は定常状態(steady state)— まだブリーチが続いている限りここに留まり続け、
 * `cooldown` 秒ごとにのみ再通知する(PHASE5_PLAN.md「Cooldown」節):
 *   - DOWN → DOWN、まだブリーチ中かつ `now - lastNotifiedAt >= cooldown` 秒 → 再通知あり
 *     (「まだ落ちている」通知。`lastNotifiedAt` を更新するのみ — Cooldown 節の
 *     「状態自体はクールダウン駆動の再通知では変化しない」の通り、`state` は `DOWN` のまま)
 *   - DOWN → DOWN、まだブリーチ中だが cooldown 未経過 → 抑制(通知なし)
 * `alertId`/`ruleId` などインシデントを一意に紐づけるフィールドは `FIRING` 遷移時に
 * 刻んだものをそのまま引き継ぐ(Duplicate Suppression 節 — 同一インシデントの
 * 「開始」「継続」「解消」を1つの `alertId` の下でスレッドとして相関させるため)。
 * `alert.timestamp` はこの再通知そのものが発生した時刻(このティックの `now`)であり、
 * `alertId` に埋め込まれた `incidentStartedAt` とは意図的に別物。
 *
 * このティックでブリーチが解消している場合(`resolveAfterBreachClears` に委譲、Task 2.7)
 * は `clearThreshold` を下回っていれば `RECOVERING` へ、デッドゾーン内であれば `DOWN` に
 * 留まる(いずれも通知なし — Transition table の `DOWN → RECOVERING` ガード通り)。
 *
 * @returns {{ nextState: object, notify: boolean, alert?: object }}
 */
function evaluateFromDown(rule, value, state, now) {
  const breached = compare(value, rule.operator, rule.threshold);

  if (!breached) {
    return resolveAfterBreachClears(rule, value, state, now);
  }

  const cooldownMs = rule.cooldown * 1000;
  const dueForRenotify = now - state.lastNotifiedAt >= cooldownMs;

  if (!dueForRenotify) {
    return {
      nextState: { ...state },
      notify: false,
    };
  }

  const nextState = { ...state, lastNotifiedAt: now };

  const alert = {
    alertId: state.alertId,
    ruleId: rule.id,
    ruleName: rule.name,
    metric: rule.metric,
    value,
    operator: rule.operator,
    threshold: rule.threshold,
    severity: rule.severity,
    state: STATES.DOWN,
    previousState: STATES.DOWN,
    message: `${rule.name} is still DOWN: ${rule.metric} = ${value} (threshold ${rule.operator} ${rule.threshold})`,
    timestamp: new Date(now).toISOString(),
  };

  return { nextState, notify: true, alert };
}

/**
 * `state.state === STATES.RECOVERING` から始まる1ティック分の評価(Task 2.7)。
 * ガードは `rule.operator`/`rule.threshold` による「元のブリーチ条件」への再ブリーチ有無
 * (`clearThreshold` ではない)— PHASE5_PLAN.md「Hysteresis」節の「`clearSince` ...
 * cleared if it breaches again」の "breaches" は Duration 節と同じブリーチ条件を指す
 * (symmetric mechanism と明記されている)ため、`clearThreshold` とのデッドゾーンは
 * `RECOVERING` の再ブリーチ判定には関与しない — `resolveAfterBreachClears` とは非対称:
 *   - 元のしきい値に再ブリーチ → `DOWN`(`clearSince` をリセット。Duplicate Suppression
 *     節の通り、新しい `alertId` は発行せず・通知もしない — 同一インシデントの継続)
 *   - 再ブリーチなし、`hysteresis` 秒未満しかクリア継続していない → `RECOVERING` 継続、
 *     `clearSince` は据え置き(breachSince と対称 — 最初にクリアしたティックで刻んだ
 *     ものを引き継ぐだけで、このティックでは更新しない)
 *   - 再ブリーチなし、`hysteresis` 秒以上クリアが継続 → `OK`(通知あり — "resolved"。
 *     `alert.alertId` にはクローズするインシデントの ID を残しつつ、`nextState` は
 *     `createInitialState()` と同じ形に戻す — 次にまた `OK → FIRING` する際は
 *     新しいインシデントとして新しい `alertId` を発行する)
 * @returns {{ nextState: object, notify: boolean, alert?: object }}
 */
function evaluateFromRecovering(rule, value, state, now) {
  const breachedAgain = compare(value, rule.operator, rule.threshold);

  if (breachedAgain) {
    return {
      nextState: { ...state, state: STATES.DOWN, clearSince: null },
      notify: false,
    };
  }

  const hysteresisMs = rule.hysteresis * 1000;

  if (now - state.clearSince < hysteresisMs) {
    return {
      nextState: { ...state },
      notify: false,
    };
  }

  const resolvedAt = new Date(now).toISOString();

  const nextState = {
    state: STATES.OK,
    breachSince: null,
    clearSince: null,
    lastNotifiedAt: now,
    alertId: null,
  };

  const alert = {
    alertId: state.alertId,
    ruleId: rule.id,
    ruleName: rule.name,
    metric: rule.metric,
    value,
    operator: rule.operator,
    threshold: rule.threshold,
    severity: rule.severity,
    state: STATES.OK,
    previousState: STATES.RECOVERING,
    message: `${rule.name} has RESOLVED: ${rule.metric} = ${value} (threshold ${rule.operator} ${rule.threshold})`,
    timestamp: resolvedAt,
  };

  return { nextState, notify: true, alert };
}

/**
 * ルール1件を1ティック分評価し、次のランタイム状態を返す(純粋関数、I/Oなし)。
 * PHASE5_PLAN.md の「State Machine」節・Transition table に準拠。
 *
 * Task 2.4〜2.7 により、`state.state` の4値すべて(`OK`/`FIRING`/`DOWN`/`RECOVERING`)
 * からの遷移を実装済み。詳細は `evaluateFromOk` / `evaluateFromFiring` /
 * `evaluateFromDown` / `evaluateFromRecovering` / `resolveAfterBreachClears` の
 * JSDoc を参照。
 *
 * `value` が `undefined`(resolveMetric が「データなし」を返した場合)を渡すかどうかは
 * 呼び出し元の責務 — 本来はそのティックの評価自体をスキップすべきだが、万一そのまま
 * 渡された場合も compare() の null-safety により「非ブリーチ」として扱われるため、
 * 誤って発報することはない。
 *
 * @param {object} rule - normalizeRule() 済みのルール定義
 * @param {number} value - resolveMetric() で解決済みのメトリクス値
 * @param {object} state - このルールの現在のランタイム状態
 * @param {number} now - 現在時刻(epoch ms。通常は `Date.now()`)
 * @returns {{ nextState: object, notify: boolean, alert?: object }}
 * @throws {Error} `state.state` が `STATES` のいずれにも一致しない場合(RuleStore/
 *   AlertEngine 側で保証されるため、通常到達しない — compare() の未知オペレータ扱いと
 *   同様の defense-in-depth)
 */
function evaluate(rule, value, state, now) {
  if (state.state === STATES.OK) {
    return evaluateFromOk(rule, value, state, now);
  }

  if (state.state === STATES.FIRING) {
    return evaluateFromFiring(rule, value, state, now);
  }

  if (state.state === STATES.DOWN) {
    return evaluateFromDown(rule, value, state, now);
  }

  if (state.state === STATES.RECOVERING) {
    return evaluateFromRecovering(rule, value, state, now);
  }

  throw new Error(`Unknown state: ${state.state}`);
}

module.exports = {
  STATES,
  createInitialState,
  resolveMetric,
  compare,
  evaluate,
};
