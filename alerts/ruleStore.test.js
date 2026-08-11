// alerts/ruleStore.test.js
// alerts/ruleStore.js のユニットテスト:スキーマ検証・インメモリCRUD・
// JSON永続化(書き込み・再起動を模した再読込)を対象とする。
//
// 重要: このスイートは常にテンポラリパスのみを使い、実際の既定パス
// (data/alertRules.json)には一切触れない。beforeEach で毎回
// ALERTS_RULES_PATH をテンポラリファイルに強制することで、実運用環境で
// このテストを誤って実行してしまっても本番データを書き換えないようにする。
// getRulesPath() の既定値フォールバック自体は文字列比較のみで検証し、
// 実際にそのパスへ書き込むことはしない。
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  ALLOWED_OPERATORS,
  ALLOWED_SEVERITIES,
  validateRule,
  normalizeRule,
  create,
  list,
  get,
  update,
  remove,
  clear,
  load,
  loadOrSeed,
  persist,
  getRulesPath,
  RuleValidationError,
  RuleNotFoundError,
  RuleConflictError,
} = require("./ruleStore");

const sample = {
  id: "disk-root-critical",
  name: "Root disk usage critical",
  metric: "disk.percent",
  operator: ">=",
  threshold: 90,
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rulestore-test-"));
function tmpFile() {
  return path.join(tmpDir, `rules-${Math.random().toString(36).slice(2)}.json`);
}

beforeEach(() => {
  clear();
  process.env.ALERTS_RULES_PATH = tmpFile();
});

afterEach(() => {
  delete process.env.ALERTS_RULES_PATH;
});

describe("validateRule", () => {
  it("accepts a fully specified valid rule", () => {
    const full = {
      ...sample,
      clearThreshold: 80,
      duration: 30,
      hysteresis: 60,
      cooldown: 1800,
      severity: "critical",
      channels: ["discord", "email"],
      enabled: true,
    };
    assert.deepEqual(validateRule(full), []);
  });

  it("accepts a minimal rule with only required fields", () => {
    assert.deepEqual(validateRule(sample), []);
  });

  it("rejects non-object input", () => {
    assert.deepEqual(validateRule(null), ["Rule must be an object"]);
    assert.deepEqual(validateRule("nope"), ["Rule must be an object"]);
    assert.deepEqual(validateRule([1, 2]), ["Rule must be an object"]);
  });

  it("reports one error per missing required field", () => {
    assert.equal(validateRule({}).length, 5);
  });

  it("enforces the id slug pattern", () => {
    const base = { name: "x", metric: "cpu.usage", operator: ">", threshold: 1 };
    assert.ok(validateRule({ ...base, id: "Disk-Root" }).length > 0);
    assert.ok(validateRule({ ...base, id: "disk root" }).length > 0);
    assert.ok(validateRule({ ...base, id: "-disk" }).length > 0);
    assert.ok(validateRule({ ...base, id: "disk-" }).length > 0);
    assert.deepEqual(validateRule({ ...base, id: "disk-root-critical" }), []);
    assert.deepEqual(validateRule({ ...base, id: "cpu99" }), []);
  });

  it("rejects an invalid operator and accepts every allowed one", () => {
    assert.ok(validateRule({ ...sample, operator: "=>" }).length > 0);
    for (const op of ALLOWED_OPERATORS) {
      assert.deepEqual(validateRule({ ...sample, operator: op }), []);
    }
  });

  it("rejects negative duration/hysteresis/cooldown but accepts zero", () => {
    assert.ok(validateRule({ ...sample, duration: -1 }).length > 0);
    assert.ok(validateRule({ ...sample, hysteresis: -5 }).length > 0);
    assert.ok(validateRule({ ...sample, cooldown: -100 }).length > 0);
    assert.deepEqual(validateRule({ ...sample, duration: 0, hysteresis: 0, cooldown: 0 }), []);
  });

  it("rejects an invalid severity and accepts every allowed one", () => {
    assert.ok(validateRule({ ...sample, severity: "urgent" }).length > 0);
    for (const s of ALLOWED_SEVERITIES) {
      assert.deepEqual(validateRule({ ...sample, severity: s }), []);
    }
  });

  it("rejects malformed channels lists", () => {
    assert.ok(validateRule({ ...sample, channels: "discord" }).length > 0);
    assert.ok(validateRule({ ...sample, channels: ["discord", 5] }).length > 0);
    assert.ok(validateRule({ ...sample, channels: ["discord", ""] }).length > 0);
    assert.deepEqual(validateRule({ ...sample, channels: [] }), []);
  });

  it("requires enabled to be a boolean when provided", () => {
    assert.ok(validateRule({ ...sample, enabled: "yes" }).length > 0);
    assert.deepEqual(validateRule({ ...sample, enabled: false }), []);
  });

  it("accepts silencedUntil as null or a valid ISO 8601 string, rejects anything else", () => {
    assert.deepEqual(validateRule({ ...sample, silencedUntil: null }), []);
    assert.deepEqual(validateRule({ ...sample, silencedUntil: new Date().toISOString() }), []);
    assert.ok(validateRule({ ...sample, silencedUntil: "not-a-date" }).length > 0);
    assert.ok(validateRule({ ...sample, silencedUntil: 12345 }).length > 0);
  });
});

describe("normalizeRule", () => {
  it("fills in every default for a minimal rule", () => {
    const normalized = normalizeRule(sample);
    assert.equal(normalized.clearThreshold, 90);
    assert.equal(normalized.duration, 0);
    assert.equal(normalized.hysteresis, 0);
    assert.equal(normalized.cooldown, 0);
    assert.equal(normalized.severity, "warning");
    assert.deepEqual(normalized.channels, []);
    assert.equal(normalized.enabled, true);
    assert.equal(normalized.silencedUntil, null);
  });

  it("preserves an explicit silencedUntil", () => {
    const until = "2026-08-08T20:00:00.000Z";
    assert.equal(normalizeRule({ ...sample, silencedUntil: until }).silencedUntil, until);
  });

  it("preserves explicitly provided values, including falsy ones", () => {
    const explicit = { ...sample, clearThreshold: 80, enabled: false, duration: 0 };
    const normalized = normalizeRule(explicit);
    assert.equal(normalized.enabled, false);
    assert.equal(normalized.duration, 0);
    assert.equal(normalized.clearThreshold, 80);
  });

  it("does not mutate its input", () => {
    const input = { ...sample };
    const snapshot = JSON.stringify(input);
    normalizeRule(input);
    assert.equal(JSON.stringify(input), snapshot);
  });

  it("defensively copies the channels array (no aliasing with the caller's array)", () => {
    const channels = ["discord"];
    const normalized = normalizeRule({ ...sample, channels });
    channels.push("slack");
    assert.deepEqual(normalized.channels, ["discord"]);
  });
});

describe("CRUD", () => {
  it("create() stores and returns the normalized rule", () => {
    const created = create(sample);
    assert.equal(created.id, "disk-root-critical");
    assert.equal(created.clearThreshold, 90);
    assert.equal(created.enabled, true);
    assert.deepEqual(created.channels, []);
  });

  it("create() throws RuleValidationError with .errors for an invalid rule", () => {
    assert.throws(
      () => create({ id: "bad" }),
      (err) => {
        assert.ok(err instanceof RuleValidationError);
        assert.ok(Array.isArray(err.errors) && err.errors.length > 0);
        return true;
      }
    );
  });

  it("create() throws RuleConflictError on duplicate id", () => {
    create(sample);
    assert.throws(() => create(sample), RuleConflictError);
  });

  it("list() returns all created rules, or [] when empty", () => {
    assert.deepEqual(list(), []);
    create(sample);
    create({ ...sample, id: "cpu-high", metric: "cpu.usage" });
    assert.deepEqual(list().map((r) => r.id).sort(), ["cpu-high", "disk-root-critical"]);
  });

  it("get() returns the correct rule, throws RuleNotFoundError otherwise", () => {
    create(sample);
    assert.equal(get("disk-root-critical").name, "Root disk usage critical");
    assert.throws(() => get("does-not-exist"), RuleNotFoundError);
  });

  it("update() merges changes and preserves untouched fields", () => {
    create(sample);
    const updated = update("disk-root-critical", { threshold: 95, severity: "critical" });
    assert.equal(updated.threshold, 95);
    assert.equal(updated.severity, "critical");
    assert.equal(updated.metric, "disk.percent");
  });

  it("update() ignores attempts to change id", () => {
    create(sample);
    const updated = update("disk-root-critical", { id: "someone-else", threshold: 99 });
    assert.equal(updated.id, "disk-root-critical");
    assert.throws(() => get("someone-else"), RuleNotFoundError);
    assert.equal(get("disk-root-critical").threshold, 99);
  });

  it("update() throws RuleNotFoundError for a missing id", () => {
    assert.throws(() => update("does-not-exist", { threshold: 1 }), RuleNotFoundError);
  });

  it("update() throws RuleValidationError and leaves the store unchanged if the merge is invalid", () => {
    create(sample);
    assert.throws(() => update("disk-root-critical", { operator: "=>" }), RuleValidationError);
    assert.equal(get("disk-root-critical").operator, ">=");
  });

  it("remove() deletes the rule; subsequent get()/remove() throw RuleNotFoundError", () => {
    create(sample);
    remove("disk-root-critical");
    assert.throws(() => get("disk-root-critical"), RuleNotFoundError);
    assert.throws(() => remove("disk-root-critical"), RuleNotFoundError);
    assert.deepEqual(list(), []);
  });

  it("clear() empties the store", () => {
    create(sample);
    create({ ...sample, id: "cpu-high" });
    clear();
    assert.deepEqual(list(), []);
  });

  it("never leaks internal references: mutating a returned clone doesn't affect stored state", () => {
    create(sample);
    const returned = get("disk-root-critical");
    returned.channels.push("email");
    returned.threshold = 999;
    const again = get("disk-root-critical");
    assert.deepEqual(again.channels, []);
    assert.equal(again.threshold, 90);
  });

  it("never leaks internal references: two list() calls return independent arrays/objects", () => {
    create(sample);
    const first = list();
    first[0].threshold = 1;
    first[0].channels.push("webhook");
    const second = list();
    assert.equal(second[0].threshold, 90);
    assert.deepEqual(second[0].channels, []);
  });

  it("never leaks internal references: mutating the input rule after create() doesn't corrupt stored state", () => {
    const channels = ["discord"];
    create({ ...sample, channels });
    channels.push("slack");
    assert.deepEqual(get("disk-root-critical").channels, ["discord"]);
  });
});

describe("persistence", () => {
  it("getRulesPath() reflects ALERTS_RULES_PATH, falls back to the default path when unset", () => {
    const guard = process.env.ALERTS_RULES_PATH;
    assert.equal(getRulesPath(), guard);

    delete process.env.ALERTS_RULES_PATH;
    // String assertion only — deliberately never write to this path from a test.
    assert.ok(getRulesPath().endsWith(path.join("data", "alertRules.json")));
    process.env.ALERTS_RULES_PATH = guard;
  });

  it("persist() writes the current rules to the given path as a JSON array", () => {
    const file = tmpFile();
    create(sample);
    persist(file);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].id, "disk-root-critical");
  });

  it("load() round-trips persisted rules after clear()", () => {
    const file = tmpFile();
    create(sample);
    create({ ...sample, id: "cpu-high", metric: "cpu.usage" });
    persist(file);
    clear();
    assert.deepEqual(list(), []);
    assert.deepEqual(load(file), { loaded: 2, skipped: 0 });
    assert.deepEqual(list().map((r) => r.id).sort(), ["cpu-high", "disk-root-critical"]);
  });

  it("load() resets to empty without throwing when the file doesn't exist", () => {
    create(sample);
    const result = load(tmpFile());
    assert.deepEqual(result, { loaded: 0, skipped: 0 });
    assert.deepEqual(list(), []);
  });

  it("load() resets to empty without throwing on corrupted JSON", () => {
    const file = tmpFile();
    fs.writeFileSync(file, "{ not valid json ][", "utf8");
    assert.deepEqual(load(file), { loaded: 0, skipped: 0 });
    assert.deepEqual(list(), []);
  });

  it("load() resets to empty without throwing when the JSON isn't an array", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ not: "an array" }), "utf8");
    assert.deepEqual(load(file), { loaded: 0, skipped: 0 });
    assert.deepEqual(list(), []);
  });

  it("load() skips individually invalid rules but loads the valid ones", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify([sample, { id: "broken", operator: "nope" }]), "utf8");
    assert.deepEqual(load(file), { loaded: 1, skipped: 1 });
    assert.deepEqual(list().map((r) => r.id), ["disk-root-critical"]);
  });

  it("load() skips duplicate ids within the same file (first one wins)", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify([sample, { ...sample, name: "duplicate" }]), "utf8");
    assert.deepEqual(load(file), { loaded: 1, skipped: 1 });
    assert.equal(get("disk-root-critical").name, "Root disk usage critical");
  });

  it("create()/update()/remove() write through to disk immediately", () => {
    const file = process.env.ALERTS_RULES_PATH;
    create(sample);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 1);

    update("disk-root-critical", { threshold: 95 });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))[0].threshold, 95);

    remove("disk-root-critical");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), []);
  });

  it("clear() does NOT write to disk", () => {
    const file = process.env.ALERTS_RULES_PATH;
    create(sample);
    const before = fs.readFileSync(file, "utf8");
    clear();
    const after = fs.readFileSync(file, "utf8");
    assert.equal(after, before);
    assert.deepEqual(list(), []);
  });

  it("simulated restart: rules persisted before a restart are available after re-load", () => {
    const file = tmpFile();
    create({ ...sample, severity: "critical", channels: ["discord"] });
    persist(file);

    // Simulate a process restart: wipe in-memory state, exactly as a fresh
    // process would start with nothing loaded yet.
    clear();
    assert.deepEqual(list(), []);

    const result = load(file);
    assert.deepEqual(result, { loaded: 1, skipped: 0 });
    const restored = get("disk-root-critical");
    assert.equal(restored.severity, "critical");
    assert.deepEqual(restored.channels, ["discord"]);
  });

  // fs はモジュール全体を require しているため(分割代入ではない)、
  // fs.readFileSync を一時的にモンキーパッチして existsSync 通過後の読み取り
  // 失敗(パーミッション等)を再現できる。他の load() エラーケース(存在しない・
  // 壊れたJSON・配列でない)とは異なり、実ファイルシステム操作だけでは
  // 安定して再現できないため、これが妥当な手段。
  it("load() resets to empty and warns without throwing when the file exists but can't be read", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify([sample]), "utf8");
    create(sample); // pollute the in-memory store first, to prove load() still clears it

    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = (targetPath, ...rest) => {
      if (targetPath === file) {
        throw new Error("EACCES: permission denied");
      }
      return originalReadFileSync(targetPath, ...rest);
    };
    try {
      const result = load(file);
      assert.deepEqual(result, { loaded: 0, skipped: 0 });
      assert.deepEqual(list(), []);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  });
});

describe("loadOrSeed()", () => {
  it("when the rules file already exists: loads from it (ignoring the seed), reports seeded: false", () => {
    const file = tmpFile();
    const seedFile = tmpFile();
    fs.writeFileSync(file, JSON.stringify([sample]), "utf8");
    fs.writeFileSync(seedFile, JSON.stringify([{ ...sample, id: "seed-only-rule" }]), "utf8");

    const result = loadOrSeed(file, seedFile);
    assert.deepEqual(result, { loaded: 1, skipped: 0, seeded: false });
    assert.deepEqual(list().map((r) => r.id), ["disk-root-critical"]);
  });

  it("when the rules file doesn't exist: seeds from seedFilePath, persists it to filePath, reports seeded: true", () => {
    const file = tmpFile(); // deliberately never created
    const seedFile = tmpFile();
    fs.writeFileSync(seedFile, JSON.stringify([sample]), "utf8");

    const result = loadOrSeed(file, seedFile);
    assert.deepEqual(result, { loaded: 1, skipped: 0, seeded: true });
    assert.deepEqual(list().map((r) => r.id), ["disk-root-critical"]);

    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].id, "disk-root-critical");
  });
});
