# SND@HOME Investigation Log — "13 real devices, 11 detected"

**Status:** Root cause found and fixed. Follow-up verification (Docker `network_mode: host` on genuine Linux) also complete. No open items.

This is a chronological record of a real device-undercount bug on the LAN Device Monitoring feature (`lan/lanEngine.js` / `lan/lanScanner.js` / `lan/deviceStore.js`), from first report through root cause, fix, and the Docker networking question it raised along the way. Kept separate from `PHASE6_DOCKER_PLAN.md` (which owns the Docker *design* decision and its own empirical-verification sections) — this document is the incident narrative; the plan doc is the living design spec that narrative fed into.

---

## 1. The report

13 physical devices known to be on the LAN were being detected/counted as only 11 by `GET /api/lan/status`'s `knownDeviceCount`. Investigated with no code changes at first, per explicit instruction, to separate root-causing from fixing.

## 2. First fix — `613236f` (2026-08-11 17:40 JST)

Two independent, real causes found, neither requiring any change to `deviceStore.js`'s deliberate MAC-less-device exclusion policy:

1. `deviceStore.recordScan()` already computed `skippedNoMac` (devices seen by ping/ARP but excluded from the ledger for lacking a stable MAC) every scan tick, but nothing surfaced it — `onlineCount` and `knownDeviceCount` could silently diverge with no diagnostic to explain why.
2. `lan/lanScanner.js`'s `detectLocalSubnet()` auto-detection could pick the wrong interface on a multi-interface host, scanning a subnet the real devices weren't even on.

Fix: `lanEngine` now keeps the last `recordScan()` result and exposes it as `unresolvedMacCount` on `/api/lan/status`; added `LAN_SCAN_CIDR` as an explicit override for auto-detection. This made the *symptom* diagnosable — it did not yet explain why MACs were going unresolved in the first place.

## 3. Root cause — `dc1138f` (2026-08-11 18:06 JST)

`readArpTable()` called plain `arp -a`, which reverse-DNS-resolves every IP to a hostname. On this machine, with no reachable resolver for private addresses, that single call took **13 seconds** — far past `DEFAULT_ARP_TIMEOUT_MS`'s 2s budget — so `execFile`'s timeout killed it on **every single scan**. The fallback path (`ip neigh show`) doesn't exist on macOS either, so the result was always an empty map: every online device's MAC went unresolved, and none of them ever reached the device ledger. Confirmed live before the fix: `onlineCount: 12, knownDeviceCount: 0, unresolvedMacCount: 12`.

Fix: `arp -a` → `arp -an` (`-n` = numeric, no hostname resolution). Same call: 14ms instead of 13s, correct data. Confirmed live after the fix: `onlineCount: 12, knownDeviceCount: 12, unresolvedMacCount: 0`.

**This was the actual bug.** Later re-confirmed in production over a longer window at the original reported scale: `knownDeviceCount: 13, unresolvedMacCount: 0`.

## 4. Follow-up question this raised — does Docker's `network_mode: host` actually preserve this?

`PHASE6_DOCKER_PLAN.md` recommends `network_mode: host` as the only mode giving the container real LAN access (default bridge scans only Docker's own isolated virtual subnet, seeing zero real devices). That recommendation carried an unstated assumption worth checking empirically, the same way the count-mismatch bug itself was: does "host" networking actually mean the *physical* host's network everywhere, or only sometimes?

### 4a. macOS / Colima — parity does NOT hold

Tested via Colima (this machine has no Docker Desktop). Two failures, neither anticipated going in:

- **Container unreachable from the Mac's own `localhost`.** `network_mode: host` under Colima binds inside the **Lima VM's** namespace, which isn't forwarded back to the Mac. Confirmed by stopping the native process and re-running the same `curl` — it then failed outright.
- **LAN scan saw the VM's own virtual subnet, not the real LAN.** `docker exec ... ip addr show` showed `192.168.5.1/24` (Colima's own Lima VM subnet) instead of the real `192.168.1.0/24`. Result: `onlineCount: 2, knownDeviceCount: 1, unresolvedMacCount: 1` (the VM's own gateway plus one synthetic neighbor) vs. the native process's concurrent `onlineCount: 12, knownDeviceCount: 12, unresolvedMacCount: 0` on the same real network.

Conclusion at this point: the "Linux only" caveat in the plan's networking-mode table undersold the problem — on macOS, `host` mode isn't merely LAN-limited, it's equivalent to running fully isolated, minus even bridge mode's port-forwarding.

### 4b. Genuine Linux (2026-08-12) — parity CONFIRMED, measured not assumed

The Colima run only disproved macOS; the Linux half of the recommendation was still just architecturally-reasoned, not tested — Colima's whole problem *is* the VM layer, so it could never stand in for real Linux hardware.

Closed this gap on a genuine Linux Mint 22 host, `masa@192.168.1.44` (kernel `6.8.0-136-generic`, no hypervisor/VM layer), on the same physical LAN (`192.168.1.0/24`) already used above:

1. Installed Docker Engine via the official `get.docker.com` convenience script (host had no Docker at all beforehand — a real environment gap, not anticipated by the original plan).
2. Fresh `git clone` of this repo (commit `6b0fa43` at the time), `docker build`, `docker run --network host`.
3. **`docker exec snd-home-verify arp -an` was byte-for-byte identical to the bare host's own `arp -an`** — 12/12 matching IP/MAC pairs. This is the definitive version of the check the Colima run couldn't pass: on real Linux, `network_mode: host` isn't an approximation of the host's network namespace, it *is* the host's network namespace.
4. `curl http://localhost:3000/api/health` against the host's own `localhost` worked immediately — no VM boundary to cross, unlike the Colima case.
5. `GET /api/lan/status` read `knownDeviceCount: 12, onlineCount: 13–14, unresolvedMacCount: 2` across three scan cycles (120s apart), while the Mac's native process concurrently reported `14/14/0` for the same real LAN. The 2 unresolved-MAC devices on the Linux host were confirmed (via the identical `arp -an` comparison) to be a property of that host's own ARP cache/timing, not a Docker artifact — the same 2 devices would be unresolved running this app natively there too.

**Conclusion: `network_mode: host` delivers full, genuine LAN parity when the Docker daemon runs directly on Linux — now measured, not just architecturally assumed.** The macOS/Colima finding stands unchanged: it was never a test of this case, only of what happens when a VM is interposed and still called "host."

Documented in full in `PHASE6_DOCKER_PLAN.md`'s Central Design Decision section and Stage 4 checklist, and in `README.md`'s Docker comparison table (commit `ed133b8`). Verification artifacts (the `snd-home-verify` image and `~/SND_HOME_verify` clone) were removed from the Linux host afterward; only shared base images (`node:20-bookworm-slim`, `hello-world`) were left in place.

---

## Timeline summary

| Date (JST) | Event |
|---|---|
| 2026-08-11 17:40 | `613236f` — `unresolvedMacCount` diagnostic + `LAN_SCAN_CIDR` override added; root cause not yet found |
| 2026-08-11 18:06 | `dc1138f` — root cause found and fixed (`arp -a` → `arp -an`); live-verified `13/13/0` |
| — | Docker `network_mode: host` tested via Colima (macOS) — LAN parity found **not** to hold, container also unreachable from `localhost` |
| 2026-08-12 | Docker `network_mode: host` tested on genuine Linux Mint hardware — LAN parity **confirmed** via identical `arp -an` output between container and host |
| 2026-08-12 | `ed133b8` — `PHASE6_DOCKER_PLAN.md` and `README.md` updated with the genuine-Linux results; verification artifacts cleaned up from the Linux host |
