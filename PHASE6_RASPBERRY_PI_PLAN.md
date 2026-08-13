# Phase 6 Implementation Plan — Raspberry Pi Agent

**Status:** Verified on real Raspberry Pi hardware via `npm start` (native, no Docker). Scope deliberately narrow — see Central design decision below.
**Depends on:** Nothing. Independent of Docker support and Cloudflare Tunnel integration (the other two completed Phase 6 items).
**Scope:** Phase 6 in README's Roadmap lists four items — Docker support, Cloudflare Tunnel integration, a Raspberry Pi agent, and multi-node monitoring. This document covers **the Raspberry Pi agent only**, the third of the four. **Multi-node monitoring (the aggregator side) is explicitly out of scope here** — see Central design decision for why, and why that's a deliberate scoping choice, not an oversight.

---

# Objectives

1. Answer, empirically, whether SND@HOME's existing codebase — unmodified — actually runs on real Raspberry Pi hardware, the same "measured, not assumed" standard applied to Docker's networking-mode verification (`PHASE6_DOCKER_PLAN.md`).
2. Identify the appropriate install method for Node.js on Pi-class hardware (constrained RAM, 32-bit ARM on older models) and confirm it satisfies README's stated `>=18` requirement.
3. Confirm the app's existing platform-abstraction points (`readArpTable()`'s `arp`→`ip neigh` fallback, `df`/`netstat` GNU/Linux dialect already covered by the Docker Linux verification) hold up on Pi hardware specifically, not just generic x86 Linux.

**Non-objectives (deferred):** any new "agent-only" code path (a stripped-down mode with no dashboard/alerting, meant to feed a future central aggregator); the multi-node aggregator itself; Docker on Raspberry Pi (deferred per the Central design decision below — can be revisited on more capable Pi hardware, e.g. Pi 4/5 with more RAM, as a follow-up); any change to `server.js` or any collector/scanner code.

---

# Central design decision: scope (agent-only mode vs. "does the existing app run on a Pi")

README's own Future Vision section describes "Raspberry Pi Agents" and "Multi-node Aggregator" as two separate roadmap boxes, both currently unbuilt, both with zero existing design or code (confirmed by grep across the repo before starting this work — the word "agent" appears nowhere in application code). Two ways to scope "Raspberry Pi agent" as a deliverable were considered:

| Option | What it means | Trade-off |
|---|---|---|
| **Design a new lightweight agent-only mode** (collectors only, no dashboard UI, no alert engine, reports metrics to a future aggregator) | A genuinely new feature: a wire protocol/API contract for agent→aggregator reporting | The consumer (multi-node aggregator) doesn't exist yet — this would be speculative code built against an interface that isn't designed, let alone built. Real risk of designing the wrong contract and having to redo it once the aggregator's actual needs are known |
| **Verify + document that the existing, unmodified app runs correctly on real Pi hardware** | No new code. "Raspberry Pi Agent" becomes: yes, you can run SND@HOME itself on a Pi, monitoring that Pi, the same way you'd run it on any Linux box | Doesn't deliver the "many Pis reporting into one dashboard" vision on its own — that's still `Multi-node Monitoring`'s job, deliberately left for its own future plan document |

**Decided (confirmed with the user before implementation): the narrow option.** Same rationale as Cloudflare Tunnel's security-posture decision — don't design a speculative interface (agent→aggregator protocol) before its actual consumer exists. This mirrors how Docker support was scoped: verify the existing app against real, unmodified constraints (there, networking modes; here, ARM architecture and constrained RAM) rather than inventing new mechanism. Multi-node monitoring, when it's tackled, should design the aggregator and whatever the agent needs to report to it *together*, informed by real requirements rather than guessed ones.

---

# Hardware & environment (real, measured)

Tested against a real, physical Raspberry Pi on the same LAN already used for the Docker Linux verification (`192.168.1.0/24`):

| | |
|---|---|
| **Model** | Raspberry Pi 3 Model B Rev 1.2 (`/proc/cpuinfo`) — 4 cores |
| **RAM** | 921Mi total (`free -h`) — genuinely constrained; swap (511Mi) already partially in use at idle |
| **OS** | Raspbian GNU/Linux 12 (bookworm), kernel `6.12.20+rpt-rpi-v7` |
| **Architecture** | `armv7l` (32-bit/armhf) — the OS install is 32-bit even though the Pi 3's CPU is 64-bit-capable; a common real-world configuration, not a misconfiguration, and the one this plan had to actually handle |
| **Disk** | 116GB microSD, 8% used |
| **Network** | `wlan0`, `192.168.1.150/24` (Wi-Fi; onboard Pi 3 Wi-Fi showed occasional transient SSH disconnects during this work — not something this plan can fix, noted as a real-world operating condition) |

---

# Node.js install method

Compared four options before choosing (`apt` package / NodeSource script / `nvm` / compile from source) — see the comparison presented to and confirmed by the user. **Decided: Raspbian's own `apt` package** (`nodejs` + `npm`, separate packages on Debian).

Rationale: `package.json` has no `engines` field (README's `>=18` is documentation-only, not npm-enforced); the app's only three runtime dependencies (`dotenv`, `express`, `nodemailer`) have no native/compiled bindings, so no ARM-specific build risk exists regardless of install method. Given that, `apt` won on every axis that mattered for *this* hardware: no third-party repo, no `curl | bash`, no compilation (critical on a 1GB-RAM, swap-already-active machine), and versions fully managed by the existing `apt upgrade` workflow.

```
sudo apt-get update
sudo apt-get install -y nodejs npm
```

**Measured result:** `node --version` → `v18.20.4`, `npm --version` → `9.2.0` — satisfies README's `Node.js >= 18` requirement exactly. Install completed in a few minutes on this hardware (apt resolved and configured ~90 packages total, including some larger transitive Debian `node-*` tooling packages such as `webpack`/`babel7` pulled in by the `npm` package's own dependency chain — not something this project asked for, but harmless: confirmed it doesn't affect the app itself, which only ever `require()`s its own three runtime dependencies).

---

# Verification (real, measured — not assumed)

Fresh `git clone` of this repo (commit `6595e0f` at the time) into a scratch directory, `cp .env.example .env`, `npm install`, `npm start` — no code changes, no Pi-specific configuration.

- **`npm install`**: 89 packages added, 0 vulnerabilities, ~13.5s.
- **`npm start`**: booted cleanly — `SND@HOME server listening on port 3000`, alert engine started (seeded 3 default rules), background polling started, LAN scanning started. Same startup log sequence as every other platform this app has been verified on.
- **`GET /api/health`** (from another machine on the LAN): `{"status":"ok"}`.
- **`GET /api/system`**: real data from the Pi itself — `hostname: "raspberrypi"`, 4 cores, memory/disk percentages matching what `free`/`df` reported directly on the Pi.
- **`GET /api/lan/status`**: `knownDeviceCount: 13, onlineCount: 15, unresolvedMacCount: 1` — real devices on the same `192.168.1.0/24` LAN already used for the Docker verification, confirming `lan/lanScanner.js`'s scan pipeline works correctly on this hardware.
- **The `arp` binary is absent on this OS image** (confirmed via `find /` — genuinely not installed, not just missing from `PATH`), but `lan/lanScanner.js`'s existing `ip neigh` fallback path (already built for exactly this situation, see `dc1138f`/`PHASE6_DOCKER_PLAN.md`'s Base image section) picked up the slack with no code changes — the LAN scan log (`scan complete: 15/254 online (1 skipped: no MAC resolved)`) confirms this worked correctly.
- **Resource footprint**: the running `node server.js` process used ~51MB RSS — light enough that this 1GB-RAM Pi 3 ran it without visible strain (CPU/memory in `/api/system`'s own self-reported figures stayed unremarkable throughout).
- Process was stopped and the scratch clone removed after verification, consistent with this project's established cleanup discipline for verification artifacts (matches the Docker/Cloudflare Tunnel verification sessions).

**Conclusion: the existing, unmodified SND@HOME codebase runs correctly on real Raspberry Pi 3 hardware (32-bit ARM, 1GB RAM) via `npm start`.** No code changes were needed. Node.js availability, the `arp`→`ip neigh` fallback, and the `df`/`netstat` GNU/Linux dialect (already covered generally by the Docker Linux verification) are all confirmed on Pi-specific hardware, not just assumed to extend from the Linux Mint desktop verification.

**Explicitly not tested, per the scoping decision above:** Docker on this Pi (deferred — a 1GB-RAM Pi 3 running a Docker daemon on top of an already-swapping system is a real resource concern this plan chose not to force; worth revisiting on Pi 4/5-class hardware with more RAM if requested) and anything related to multi-node aggregation (no aggregator exists to test against).

---

# Estimates

| | |
|---|---|
| **Total tasks** | Environment survey, Node install method comparison + install, application verification, this document — no application code |
| **Total implementation time** | ~1.5–2 hours, most of it waiting on this specific Pi 3's real-world install/package-resolution time and a few transient Wi-Fi-related SSH reconnects, not active work |
| **Risk** | **Low, and the one real risk (32-bit ARM + constrained RAM breaking something) didn't materialize.** The app's zero native/compiled dependencies meant there was never a realistic ARM-compilation risk; the actual open question was purely "does apt's Node package satisfy the version floor and does the app run without OOM on 1GB RAM" — both confirmed directly. |
| **Complexity** | **Low.** No new files beyond this plan document; `docker-compose.yml`/`.env.example`/application code all untouched. |

---

# Open decisions needing sign-off

None remaining — both real decisions (scope: narrow verification vs. new agent-mode code; Node install method: `apt` vs. NodeSource/nvm/source) were raised to and confirmed by the user before the corresponding work began, the same process used for Docker's networking-mode decision and Cloudflare Tunnel's security-posture decision.
