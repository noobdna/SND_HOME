# Autonomous Development Loop — Operating Policy

**Status:** Active. Governs any Claude Code `/loop` session working on this repository unattended or semi-attended.
**Confirmed with the user (2026-08-13):** session-tied `/loop` (not an unattended cron job — see Non-objectives), work sourced from README's Roadmap + already-flagged gaps in the codebase/docs, human approval required for merge/direct-push-to-main/deploy.

This document is the actual policy a loop iteration must follow — not a design rationale doc like `PHASE6_DOCKER_PLAN.md`/`PHASE6_CLOUDFLARE_TUNNEL_PLAN.md`/`PHASE6_RASPBERRY_PI_PLAN.md`. It exists so an unattended (or lightly-attended) loop iteration has a fixed rulebook to follow instead of improvising judgment calls a human should make.

---

# The hard boundary

**Always fully automatic, every iteration, no approval needed (fully reversible / doesn't touch shared state beyond a feature branch):**
- Create a new branch off `main` for the task.
- Implement the change.
- Run `npm test` and confirm no regressions before doing anything else.
- Commit with a descriptive message (matching this repo's existing commit-message style — see `git log`).
- Push the branch to `origin` (never `main`/`master` itself, always the feature branch).
- Open a PR via `gh pr create` with a clear description: what changed, why, and the test evidence (`npm test` output, or manual verification steps if the change isn't unit-testable).

**Never automatic — always requires an explicit human action, every time, no exceptions:**
- Merging any PR (`gh pr merge`, or clicking Merge in the GitHub UI). The loop opens PRs; it never closes the loop on them.
- Pushing or merging anything into `main`/`master` directly.
- Force-pushing to any branch, anywhere, for any reason.
- Deleting branches, tags, or releases on `origin`.
- Rewriting git history (`rebase -i` on shared branches, `commit --amend` on anything already pushed).
- Running any deploy/production command. (None exist in this repo today — `docker-compose.yml` is local/self-hosted, no CD pipeline — but this rule stands if one is ever added.)
- Modifying CI/CD configuration, branch protection rules, or repository settings.
- Skipping git hooks (`--no-verify`) or bypassing commit signing.
- Any destructive shell operation (`rm -rf` outside a scratch/verification dir, `git reset --hard`, `git clean -f`) without first checking `git status` and confirming nothing uncommitted is at risk — same standard already followed throughout this project's manual sessions (see e.g. the Docker/Cloudflare/Raspberry Pi verification work, which always cleaned up scratch clones explicitly and never touched real repo state without asking).

If a task genuinely requires one of the "never automatic" actions to be *considered* (not performed) — e.g., a change that would only make sense as a direct commit to `main` — the loop opens the PR anyway and flags the reason for the human reviewer, rather than deciding on its own that the rule doesn't apply this time.

---

# What counts as "in scope" for a loop iteration

A task is loop-eligible only if it can be implemented **without a new scope-defining conversation** — i.e., the kind of decision this project has repeatedly routed through `AskUserQuestion`/`EnterPlanMode` before implementation (Docker's networking-mode choice, Cloudflare Tunnel's security posture, Raspberry Pi's agent-vs-verification scope). If picking up a Roadmap item would require inventing a design from scratch, it is **not** loop-eligible — surface it instead of guessing.

**Sources to check each iteration, in this order:**

1. **Already-flagged, already-scoped gaps** in this repo's own `.md` docs — the specific, narrow follow-ups called out but not yet closed. Search for phrasing like "flagged, not fixed," "known gap," "still not... checked," "not yet wired up." These are the best candidates: someone already decided what "done" looks like, they just haven't been done. Examples present as of this writing (not an exhaustive or static list — re-search each time):
   - `PHASE6_DOCKER_PLAN.md`'s Stage 2 note: confirm `data/*.json` isn't baked into the Docker image and that `.dockerignore` measurably shrinks build context — never explicitly checked.
   - `PHASE5_PLAN.md`/`.env.example`'s `ALERTS_ENABLED` gap: documented as a config option but never read anywhere in the code (the alert engine always runs once started) — a single `if` in `server.js`'s startup block, already scoped by the existing comment.
   - Stale test-count figures (e.g., README lines still citing an old `npm test` pass count after the suite has grown) — verify against a fresh `npm test` run and correct any that drifted.
2. **`TODO`/`FIXME`/`XXX` comments** in application code (`grep -rn "TODO\|FIXME\|XXX" --include="*.js"`, excluding `node_modules` and `*.test.js`). None exist as of this writing — re-check each iteration, since new ones may appear.
3. **README's Roadmap** (`- [ ]` items), **excluding**:
   - Anything requiring live external credentials the loop cannot obtain unattended (Phase 5's Discord/Slack manual E2E — `API_KEY`/webhook secrets are not something a loop should ask a human to paste into chat, consistent with this session's established boundary of never requesting credentials that way).
   - Anything requiring physical/remote hardware access the loop cannot reach on its own initiative (e.g., a *new* piece of hardware — the already-established SSH access to the Linux Mint and Raspberry Pi verification hosts may be reused for narrow, already-scoped follow-ups on that same hardware, but the loop should not go looking for new hardware to test against).
   - Anything explicitly deferred by the user in conversation (currently: **Multi-node monitoring** — deferred 2026-08-13, no design exists yet, would require the same kind of scoping conversation as every other Phase 6 item before any code is written).
   - Anything with no existing plan/scope at all (e.g., the "Upcoming — Future (not yet scheduled)" table's SSL Certificate Monitoring / DNS Monitoring rows) — these need a scoping conversation first, same as Docker/Cloudflare Tunnel/Raspberry Pi each got before implementation.

**If none of the above yields a loop-eligible task:** stop the loop and report this plainly rather than inventing scope or picking something borderline. This is a legitimate, expected outcome, not a failure — as of this writing, the codebase genuinely has no eligible items until the excluded ones above are unblocked or new gaps get flagged.

---

# Iteration shape

One task per iteration, one PR per task — keeps each PR small and independently reviewable, consistent with this project's existing discipline of one well-scoped, tested, documented change per commit/PR rather than bundling unrelated work.

Each iteration:
1. Re-run the scope search above (state may have changed since the last iteration — a prior PR may have been merged, unblocking something, or a human may have added a new flagged gap).
2. If nothing eligible: report status, do not force a pick, schedule the next check.
3. If something eligible: implement it fully (including tests, and doc updates in the same style as this project's existing `PHASE*_PLAN.md`/README conventions) on its own branch, verify with `npm test`, push, open a PR, then stop and wait — do not chain immediately into a second task in the same iteration without the branch/PR from the first one landing (merged or explicitly abandoned) first, to avoid stacking unreviewed changes.

---

# Non-objectives

- **Not a cron-based, fully unattended background service.** This is a session-tied `/loop` (`ScheduleWakeup`-driven) per the confirmed design — it runs while a Claude Code session is willing to keep waking itself up, not as an independent always-on process outside any session. Revisit this document if that changes.
- **Not a replacement for the scoping process** this project has used for every real feature so far (Docker, Cloudflare Tunnel, Raspberry Pi) — the loop only executes already-scoped work; it does not make architecture or security-posture decisions on its own.
- **Not authorized to expand its own permissions** — if a task seems to require an exception to the hard boundary above, that is itself a signal to stop and ask, not a reason to reinterpret the rule.
