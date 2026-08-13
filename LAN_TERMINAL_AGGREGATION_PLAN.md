# LAN Device Ledger — Terminal Aggregation

**Status:** Implemented. `lan/deviceStore.js`/`routes/lan.js`/`lan/lanEngine.js` shipped; `npm test` green. This is a refinement of the already-shipped LAN Device Monitoring feature (Phase 5), not a new Roadmap phase item — hence the plain filename rather than `PHASE*_PLAN.md`.
**Depends on:** `lan/deviceStore.js`, `routes/lan.js`, `lan/lanEngine.js` (Phase 5, LAN Device Monitoring). Does not touch `lan/lanScanner.js`, `collectors/lanCollector.js`, `routes/piStatus.js`, or any frontend file.
**Scope:** manual grouping of multiple MAC-identified interfaces into one "terminal" (端末), plus the read/aggregate API for that grouping. Automatic/heuristic correlation is explicitly out of scope — see Non-objectives.

---

## Problem

The LAN Device Ledger (`lan/deviceStore.js`) keys every known device by MAC address, treating each MAC as one independent "device." This is deliberate and documented (MAC is the one stable identifier available; IP is explicitly rejected as an identity key because DHCP can reassign it — see the file's own header comment).

The gap: a single physical machine with more than one active network interface (Wi-Fi *and* Ethernet simultaneously) presents **two different MAC addresses on the LAN at once**, and the ledger counted it as two separate devices. This wasn't hypothetical — it's exactly what this project's own Docker verification work measured on the Linux Mint host used throughout Phase 6: `masa@192.168.1.44` (Wi-Fi, `wlp1s0b1`, MAC `60:33:4b:2d:1e:64`) and `masa@192.168.1.239` (wired, `enxd83062a59025`, MAC `d8:30:62:a5:90:25`) are the *same* physical machine, both simultaneously online, and the ledger held them as two unrelated entries. On a real LAN with a couple of dual-interface hosts, the ledger's device count always reads higher than the number of physical "terminals" actually present.

**Goal:** aggregate multiple MAC-identified interfaces that the operator confirms are the same physical terminal, without weakening the existing MAC-based identity model that alert rules, the Raspberry Pi status card, and the rest of the LAN API already depend on.

**Confirmed with the user before implementation: the correlation mechanism is manual grouping only — no automatic/heuristic correlation** (IP co-location, OUI-vendor matching, etc.). Rationale: this project has consistently avoided exactly this kind of false-positive risk elsewhere (`lan/deviceStore.js`'s own "safer side" MAC-exclusion design, the `unresolvedMacCount` diagnostic added specifically so detection gaps don't go unnoticed) — an automatic correlator that guesses wrong would silently merge two genuinely different devices into one terminal, making one of them invisible to monitoring. A home LAN has few enough dual-interface hosts (realistically 1–2) that manual grouping isn't a meaningful burden, and it carries zero false-positive risk.

---

## Design: additive "Terminal" grouping layer

**Core decision: additive, not a replacement.** The existing MAC-keyed device shape, `GET /devices`, `GET /devices/:mac`, the `lan.devices.<mac>.online` alert dot-path, and `routes/piStatus.js` all keep working completely unchanged. Terminal aggregation is a new, optional layer *on top of* the existing ledger — an operator who never groups anything sees zero behavior change anywhere, matching this project's consistent "opt-in, no silent behavior change" philosophy (same shape as `API_KEY`, `ALERTS_ENABLED`, every notifier's `*_ENABLED`).

**Data model:** each device record in `lan/deviceStore.js` gained one new field:
- `terminalId: string | null` — defaults to `null` (not grouped; the device is implicitly its own terminal). When grouped, this holds the MAC of the group's "primary" interface. Using the primary MAC itself as the terminal ID (rather than inventing a UUID scheme) keeps the identifier in the same string-MAC style already used everywhere in this codebase (URLs, dot-paths, `DeviceNotFoundError`), and needs no new ID-generation/persistence concern.

**`deviceStore.js` functions** (alongside the existing `setNickname` pattern):
- `groupTerminal(mac, primaryMac)` — sets `mac`'s `terminalId` to `primaryMac`. Validates both MACs exist in the ledger (`DeviceNotFoundError` otherwise, same as `setNickname`); rejects grouping a MAC with itself (`TerminalValidationError`).
- `ungroupTerminal(mac)` — `groupTerminal(mac, null)`.
- `listTerminals()` — aggregates `list()` by effective terminal (a device's own MAC if `terminalId` is null, else its `terminalId`) into `{ terminalId, displayIp, online, macs, nickname, firstSeenAt, lastSeenAt }` per group. `displayIp` = the IP of whichever grouped interface has the most recent `lastSeenAt` (the "IP基準" half of the original request — the terminal is *identified* by MAC internally, but *displayed* by its current, most-relevant IP). `online` = true if *any* grouped interface is online (a terminal is reachable if any of its interfaces is). `nickname` comes from the member whose own `mac` equals `terminalId` (the primary/representative interface).

**API additions** (`routes/lan.js`, still fully `requireAuth`-gated like the rest of this router):
- `PATCH /devices/:mac` — extended to also accept `terminalId` in the body (alongside the existing `nickname` field); either field, or both, may be present in one request (at least one is required).
- `GET /terminals` — new, returns `{ status: "ok", data: deviceStore.listTerminals() }`.

**`lan/lanEngine.js`**: `getStatus()` gained one additive field, `knownTerminalCount` (from `deviceStore.listTerminals().length`), alongside the existing `knownDeviceCount` — both are shown, neither replaces the other.

**`collectors/lanCollector.js`**: **unchanged**. The existing per-MAC `lan.devices.<mac>.online` publishing stays exactly as-is (real alert rules may already depend on it). A future, separate addition of `lan.terminals.<terminalId>.online` dot-paths is possible but out of scope here — not requested, and would need its own sign-off given it's a new alerting surface.

---

## What changed

| File | Change |
|---|---|
| `lan/deviceStore.js` | Added `terminalId` field to the device record shape (default `null`, persisted/loaded like `nickname`); added `groupTerminal()`, `ungroupTerminal()`, `listTerminals()`, `pickTimestamp()` (internal helper) |
| `lan/deviceStore.test.js` | New tests: group/ungroup happy path, grouping a MAC with itself (rejected), grouping/ungrouping a nonexistent MAC (`DeviceNotFoundError`), `listTerminals()` aggregation correctness (multi-interface group, ungrouped devices each their own terminal), `displayIp` picks the most-recently-seen interface, persistence round-trip of `terminalId` |
| `routes/lan.js` | Extended `PATCH /devices/:mac` to accept `terminalId`; added `GET /terminals` |
| `routes/lan.test.js` | New tests for both, following this file's existing supertest + `deviceStore.clear()`/scratch-path isolation convention |
| `lan/lanEngine.js` | Added `knownTerminalCount` to `getStatus()` |
| `lan/lanEngine.test.js` | New assertions for `knownTerminalCount`, including a real (non-monkeypatched) `deviceStore.recordScan()`/`groupTerminal()` case to verify the divergence from `knownDeviceCount` once grouping is used |
| `README.md` | Documented `terminalId`, `GET /api/lan/terminals`, the extended `PATCH` body, and the manual-grouping workflow in the LAN Device Monitoring / API sections |
| `LAN_TERMINAL_AGGREGATION_PLAN.md` (this file) | Design-rationale doc |

**Unchanged:** `lan/lanScanner.js` (scan logic itself has no concept of terminals — aggregation is a ledger-layer concern only), `collectors/lanCollector.js`, `routes/piStatus.js`, `middleware/auth.js`, every existing API response shape (all changes are additive fields/endpoints, nothing removed or renamed), every frontend file (no device-list UI exists to update — the dashboard only shows aggregate counts and one hardcoded device, unaffected by this).

## Non-objectives

- Automatic/heuristic correlation (explicitly rejected per the confirmed decision above).
- Changing the existing MAC-based identity model, or any existing endpoint's response shape.
- A frontend UI for viewing/managing terminals (no such UI exists today for individual devices at all; would be new scope on top of this).
- New alert-rule dot-paths at the terminal level (`lan.terminals.*`) — possible follow-up, not requested here.

## Verification

- Unit tests as listed in the table above — `npm test` full suite green, no regressions.
- Integration tests via supertest for the two `routes/lan.js` changes, including auth-gating (`requireAuth` covers `GET /terminals` and the extended `PATCH` the same as every other route on this router) and 500-path coverage via monkeypatching, matching this file's existing conventions.
- Real-server smoke test: `npm start` + `curl` against `PATCH /api/lan/devices/:mac` (with `terminalId`) and `GET /api/lan/terminals` on a running instance, confirming `GET /api/lan/devices` is unaffected by grouping.
