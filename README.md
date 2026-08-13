<div align="center">

# ⌂ SND@HOME

### AI-powered Home Infrastructure Monitoring Platform

**Turn your home server into a real, observable piece of infrastructure — no SaaS, no agents phoning home, no subscription.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![JavaScript](https://img.shields.io/badge/javascript-ES2022-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Express](https://img.shields.io/badge/express-5.x-000000?logo=express&logoColor=white)](https://expressjs.com)
[![Open Source](https://img.shields.io/badge/open%20source-%E2%9D%A4-red)](#contributing)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

</div>

---

## Why SND@HOME?

Most home labs end up with the same story: a server quietly running in a closet, and no idea whether it's healthy until something breaks. Cloud monitoring SaaS is overkill for a single box, and most self-hosted dashboards are either bloated or dead projects.

**SND@HOME** starts from the opposite direction: a small, dependency-light Express server that polls your machine's vitals on a background loop, keeps a rolling history in memory, and serves it all through a clean REST API and a zero-framework live dashboard — plus a threshold-based alert engine that pages you on Discord, Slack, email, or a generic webhook when something actually needs attention. No database (metrics — alert rules are the one exception, persisted to a JSON file). No external services required. No build step. Clone it, `npm start`, and you have a live, alerting view of your box in your browser.

It's built as a **plugin-based architecture** from day one — new metrics are `register()`-ed into the collector engine, new notification channels are `register()`-ed into the notifier registry, both without touching the polling loop, the alert engine, the API, or the dashboard. That's the foundation the roadmap below (multi-node monitoring, Raspberry Pi agents) builds on.

---

## ✨ Features

### Current (implemented)

| Feature | Description |
|---|---|
| 🖥️ **System Monitoring** | Hostname, platform, load average, and uptime via Node's `os` module |
| 🔥 **CPU Monitoring** | Real usage % computed from two `os.cpus()` samples 100ms apart, plus core count |
| 🧠 **Memory Monitoring** | Used / total / percent from `os.totalmem()` / `os.freemem()` |
| 💾 **Disk Monitoring** | Used / total / percent parsed from `df -k /` |
| 🌐 **Network Monitoring** | Interfaces, local IP, and cumulative rx/tx bytes (via `netstat -ib`) |
| ⚙️ **Background Polling Engine** | Event-driven `MonitorEngine` polls all collectors every 5s and caches the latest snapshot in memory |
| 📜 **Historical Metrics** | Ring-buffer history store (720 points ≈ 1 hour at 5s intervals) for trend charts |
| 🔌 **REST API** | JSON endpoints for live snapshot, cached snapshot, history, and engine status |
| 📊 **Real-time Dashboard** | Dependency-free HTML/CSS/JS UI with live progress bars and Canvas-drawn trend charts, auto-refreshing every 3s |
| ❤️ **Health Check** | Simple `/api/health` endpoint for uptime checks / container orchestration |
| 🚨 **Alert Engine** | Threshold-based rule evaluator (`OK → FIRING → DOWN → RECOVERING → OK`) with duration/hysteresis/cooldown debouncing, driven by the same 5s poll tick |
| 📐 **Alert Rules API** | Full CRUD (`/api/alerts/rules`) for threshold rules, persisted to JSON with write-through, seeded with sane disk/CPU/memory defaults on first run |
| 📜 **Alert History** | Ring-buffer log of every state transition (`/api/alerts/history`), independent of the live metrics history |
| 💬 **Discord Notifications** | Color-coded embed per alert, via a `fetch` POST to a Discord webhook |
| 💬 **Slack Notifications** | Plain-text message via a Slack Incoming Webhook |
| 📧 **Email Notifications** | SMTP delivery via `nodemailer`, configurable host/port/auth |
| 🪝 **Generic Webhook Notifications** | Raw JSON POST to any endpoint, optionally HMAC-SHA256 signed (`X-SND-Signature`) for PagerDuty/Opsgenie/custom receivers |
| 🔌 **Notifier Plugin Registry** | Same `register()`-based plugin pattern as collectors — one file per channel, isolated failures via `Promise.allSettled` |
| 📶 **LAN Device Monitoring** | Passive network sweep (ping + ARP/`ip neigh`, no port scanning) on its own 2-minute timer, with vendor lookup via a static OUI table and a persisted device ledger (first/last seen, online status, optional nickname) |

### Upcoming (roadmap)

| Feature | Target Phase |
|---|---|
| 🔒 SSL Certificate Monitoring | Future (not yet scheduled) |
| 🌍 DNS Monitoring | Future (not yet scheduled) |
| 🐳 Docker Support | Phase 6 |
| ☁️ Cloudflare Tunnel Integration | Phase 6 |
| 🍓 Raspberry Pi Agent | Phase 6 |
| 🕸️ Multi-node Monitoring | Phase 6 |

> SSL/DNS monitoring were originally scoped alongside alerting but ended up out of scope for the alerting implementation plan actually built (see [Roadmap](#-roadmap)) — nothing in this table exists in the code yet.

---

## 🏗️ Architecture

### Current

```mermaid
graph TB
    Browser["🌐 Browser Dashboard<br/>index.html + app.js<br/>(vanilla JS, Canvas charts)"]

    subgraph Server["⚙️ Express Server — server.js"]
        API["System API Routes<br/>/api/system · /api/health<br/>/api/system/latest<br/>/api/monitor/status<br/>/api/system/history"]
        AlertAPI["Alert API Routes<br/>/api/alerts/* · /api/notifiers/*"]
        Engine["MonitorEngine<br/>(EventEmitter, polls every 5s)"]
        History["HistoryStore<br/>ring buffer · 720 points"]
        AlertEngine["AlertEngine<br/>(subscribes to MonitorEngine 'update')"]
        RuleEval["RuleEvaluator<br/>(pure state machine)"]
        RuleStore["RuleStore<br/>JSON-persisted rules"]
        AlertHistory["AlertHistoryStore<br/>ring buffer of transitions"]
        NotifierReg["NotifierRegistry<br/>Promise.allSettled dispatch"]
    end

    Registry["CollectorRegistry<br/>collectAll()"]

    subgraph Collectors["🔌 Collector Plugins"]
        CPU[cpuCollector]
        MEM[memoryCollector]
        DISK[diskCollector]
        NET[networkCollector]
    end

    subgraph Notifiers["📣 Notifier Plugins"]
        Discord[discordNotifier]
        Slack[slackNotifier]
        Email[emailNotifier]
        Webhook[webhookNotifier]
    end

    subgraph Host["🖥️ Host OS"]
        OSMod["Node os module"]
        DF["df -k /"]
        NETSTAT["netstat -ib"]
    end

    Browser -- "fetch every 3s" --> API
    API -- "reads cached snapshot" --> Engine
    API -- "reads history" --> History
    Engine -- "tick every 5s" --> Registry
    Registry --> CPU & MEM & DISK & NET
    Engine -- "records snapshot" --> History
    Engine -- "emits 'update'" --> AlertEngine
    AlertEngine --> RuleEval
    RuleEval --> RuleStore
    AlertEngine -- "records every transition" --> AlertHistory
    AlertEngine -- "emits 'alert'" --> NotifierReg
    NotifierReg --> Discord & Slack & Email & Webhook
    AlertAPI --> RuleStore
    AlertAPI --> AlertHistory
    AlertAPI --> NotifierReg
    CPU --> OSMod
    MEM --> OSMod
    DISK --> DF
    NET --> OSMod
    NET --> NETSTAT
```

The engine never blocks the API: routes always read from an in-memory cache, and a failed poll (e.g. `df` unavailable) just keeps the previous cached values instead of taking the server down. The alert engine follows the same philosophy — it's a subscriber of `MonitorEngine`'s `update` event, not a second polling loop, so alert state is never more stale than the dashboard itself.

### Where it's headed

```mermaid
graph LR
    subgraph Today["✅ Today"]
        A["Single-node<br/>SND@HOME instance"]
        B["Alert Engine"]
        C["Discord / Slack / Email / Webhook"]
        F["Cloudflare Tunnel<br/>(opt-in, config ready —<br/>live reachability<br/>verification pending)"]
        G["Runs on Raspberry Pi<br/>(verified via npm start,<br/>no code changes needed)"]
    end

    subgraph Vision["🔭 Vision — not yet built"]
        D["Multi-Pi Agent Reporting"]
        E["Multi-node Aggregator"]
    end

    A --> B --> C
    A -.-> F
    A -.-> G
    A -.-> D --> E
```

---

## 🛠️ Tech Stack

- **Runtime:** [Node.js](https://nodejs.org) (>=18)
- **Server:** [Express](https://expressjs.com) 5.x
- **Language:** JavaScript (ES2022, CommonJS)
- **Frontend:** Vanilla HTML5 / CSS3 / JavaScript — no frontend framework, no build step, no bundler
- **Charts:** Hand-rolled Canvas 2D line charts (no chart.js / d3 / external libs)
- **API:** REST, JSON over HTTP
- **Data storage:** In-memory (no database) — CPU/disk/network metrics come from Node's `os` module plus the `df` and `netstat` system commands; alert rules are the one thing persisted to disk, as a write-through JSON file
- **Notifications:** Discord/Slack/generic webhook via Node's built-in `fetch` (no HTTP client dependency); email via [`nodemailer`](https://www.npmjs.com/package/nodemailer) (the only notification-related dependency — Node has no built-in SMTP client)
- **Testing:** Node's built-in [`node:test`](https://nodejs.org/api/test.html) runner + [`supertest`](https://www.npmjs.com/package/supertest) for HTTP integration tests — no Jest/Mocha, keeping with the dependency-light philosophy
- **Containerization:** Docker, single-stage build from `node:20-bookworm-slim` (not Alpine — see [`PHASE6_DOCKER_PLAN.md`](PHASE6_DOCKER_PLAN.md) for why) — optional, `npm start` remains the primary supported path
- **Remote access:** [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) via the official `cloudflare/cloudflared` image — optional, off by default (Compose `profile: tunnel`); see [`PHASE6_CLOUDFLARE_TUNNEL_PLAN.md`](PHASE6_CLOUDFLARE_TUNNEL_PLAN.md)

> **Platform note:** the disk and network collectors shell out to `df -k /` and `netstat -ib`. This has been developed and tested on macOS; `df` is portable to Linux, but `netstat -ib` uses BSD-style flags — on Linux the network throughput fields (`rxBytes`/`txBytes`) may come back `null` depending on your `netstat`/`net-tools` version. Everything else works cross-platform, **including real Raspberry Pi hardware** — verified via `npm start` (no code changes) on a Raspberry Pi 3 Model B, 32-bit `armv7l`, 921MB RAM, Raspbian 12 (bookworm); see [`PHASE6_RASPBERRY_PI_PLAN.md`](PHASE6_RASPBERRY_PI_PLAN.md).

---

## 📸 Screenshots

<div align="center">

![SND@HOME Dashboard](docs/dashboard.png)

*Live dashboard — CPU / Memory / Disk usage, host info, and trend charts.*

</div>

> 📌 Screenshot placeholder — drop a dashboard capture at `docs/dashboard.png` to replace this. Run the app locally (see [Usage](#-usage)) to see it live in the meantime.

---

## 🗺️ Roadmap

- [x] **Phase 1 — Foundation**: Express server bootstrap
- [x] **Phase 2 — Core System Monitoring**: CPU, memory, disk, and network collectors + `/api/system`, `/api/health`
- [x] **Phase 3 — Background Polling Architecture**: always-on `MonitorEngine`, in-memory cache, live dashboard UI
- [x] **Phase 4 — Historical Metrics & Visualization**: ring-buffer `HistoryStore`, `/api/system/history`, Canvas trend charts
- [x] **Phase 5 — Alerting & Notifications** ✅ *Code complete — live-notification verification pending*
  - [x] Threshold-based alert engine (`OK → FIRING → DOWN → RECOVERING → OK`, duration/hysteresis/cooldown)
  - [x] Discord notifications
  - [x] Slack notifications
  - [x] Email notifications
  - [x] Generic webhook notifications (HMAC-signed)
  - [x] Alert rules REST API (CRUD + active/history/engine-status/test endpoints)
  - [ ] Manual E2E verification against a real Discord/Slack workspace *(requires live credentials — pending; the only Phase 5 item left, everything else on this checklist is code-complete and covered by the 114-test suite)*. No code changes needed — the endpoints below already exist and were exercised with mocked `fetch` during Stage 8; what's missing is a human watching a real external channel. Steps for whoever has real webhook URLs:
    1. Set `DISCORD_WEBHOOK_URL`/`DISCORD_ENABLED=true` and/or `SLACK_WEBHOOK_URL`/`SLACK_ENABLED=true` in `.env` (see the environment variable table above), then start (or restart) the server.
    2. Quick smoke test — `POST /api/notifiers/discord/test` (or `/slack`) — confirm a `[TEST]` message actually lands in the real channel.
    3. **8.1** — pick or create an alert rule with a threshold low enough to breach immediately (e.g. `disk.percent >= 1`), confirm the state machine walks `OK → FIRING → DOWN` in the running server's logs/`GET /api/alerts/active`, and confirm the real message arrives in Discord/Slack (either wait for a natural tick, or call `POST /api/alerts/rules/:id/test` to fire immediately through the rule's own dispatch path).
    4. **8.2** — raise the same rule's threshold back above current values, confirm `DOWN → RECOVERING → OK` and a resolved/recovery message arrives in the same channel.
    5. Record the result (pass/fail, and the actual message content/timestamp) here and in `PHASE5_PLAN.md`'s Stage 8 section, replacing the "deliberately skipped" notes on 8.1/8.2 with the real outcome.
  - SSL certificate monitoring and DNS monitoring were dropped from this phase's actual implementation scope; see [Upcoming](#-features) for their current status
- [ ] **Phase 6 — Distributed & Self-Hosted Platform** 📋 *Planned*
  - [x] Docker support — **fully verified**, all three networking modes measured against real hardware, none left as reasoned-but-untested. `Dockerfile`/`docker-compose.yml`/`.dockerignore` per [`PHASE6_DOCKER_PLAN.md`](PHASE6_DOCKER_PLAN.md); `npm test` unaffected (356/356). `docker build` and container startup/healthcheck confirmed working on both macOS (via Colima) and genuine Linux. Networking mode verification (see the [Docker section](#-docker) above for full measured numbers): `network_mode: host` (the compose file's default) — **falsified on macOS/Colima** (scoped to the VM's own subnet, container not even reachable from the Mac's own `localhost`) but **confirmed full real-LAN parity on genuine Linux** (2026-08-12, Linux Mint 22, `masa@192.168.1.44` — `docker exec ... arp -an` matched the bare host's `arp -an` exactly); default bridge mode — confirmed non-functional for LAN Device Monitoring on Linux, though via a loud `MAX_HOSTS` safety-cap error rather than the originally-predicted silent zero-devices result, with system monitoring/alerting/reachability unaffected; `macvlan` (opt-in, not shipped in `docker-compose.yml`) — confirmed full real-LAN identity/data on Linux, with a documented caveat that the Docker host itself can't reach the container over the macvlan's own parent interface (a kernel restriction), though it can via any other NIC on the same subnet
  - [x] Cloudflare Tunnel integration — **config + docs complete, live reachability verification pending a real Cloudflare account.** Optional `cloudflared` sidecar in `docker-compose.yml`, gated behind a Compose `profile: tunnel` (a plain `docker compose up` never starts it); `CLOUDFLARE_TUNNEL_TOKEN` added to `.env.example`; see the [Cloudflare Tunnel section](#-cloudflare-tunnel) above and [`PHASE6_CLOUDFLARE_TUNNEL_PLAN.md`](PHASE6_CLOUDFLARE_TUNNEL_PLAN.md) for the full design, including the deliberate decision to leave `middleware/auth.js`'s existing scoping unchanged and instead recommend Cloudflare Access as the real access-control layer. `npm test` unaffected (no application code touched — `cloudflared` is an external process, not app-aware). What's *not* verified: actually creating a tunnel, connecting a real hostname, and confirming public reachability — needs a real Cloudflare account/domain, not available in this session, the same category of gap as the Discord/Slack line below
  - [x] Raspberry Pi agent — **verified on real hardware, deliberately narrow scope.** No new "agent-only" code — confirmed instead that the existing, unmodified app runs correctly via `npm start` on a real Raspberry Pi 3 Model B (armv7l/32-bit, 921MB RAM, Raspbian 12/bookworm): `node`/`npm` installed via `apt` (`v18.20.4`/`9.2.0`, satisfies README's `>=18`), `npm install` + `npm start` booted cleanly, and `GET /api/health`/`/api/system`/`/api/lan/status` all returned real data — including real LAN devices on the same network already used for the Docker verification, with the `arp` binary genuinely absent on this OS image and the app's existing `ip neigh` fallback picking up the slack with zero code changes. Full account, including why the aggregator-facing "agent mode" design was deliberately deferred rather than built speculatively, in [`PHASE6_RASPBERRY_PI_PLAN.md`](PHASE6_RASPBERRY_PI_PLAN.md). Docker-on-Pi and the multi-node aggregator itself remain out of scope here — see that document
  - [ ] Multi-node monitoring

---

## 🚀 Installation

**Requirements:** Node.js >= 18, npm, and a Unix-like OS (macOS or Linux — see the platform note in [Tech Stack](#️-tech-stack)).

```bash
# Clone the repository
git clone https://github.com/<your-username>/SND_HOME.git
cd SND_HOME

# Install dependencies
npm install

# Start the server
npm start
```

Environment variables are loaded from a `.env` file via [`dotenv`](https://www.npmjs.com/package/dotenv) if one exists — copy `.env.example` to get started:

```bash
cp .env.example .env
```

No `.env` file is required to run the app; every variable has a sensible default, and every notification channel is off until you explicitly configure it. Currently supported:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the Express server listens on |
| `API_KEY` | *(none)* | Opt-in: set to require `Authorization: Bearer <API_KEY>` on the mutating `/api/alerts` and `/api/notifiers` endpoints (`middleware/auth.js`). Unset means those endpoints stay unauthenticated, as before |
| `ALERTS_ENABLED` | `true` | Master switch for the alert engine. Defaults to enabled (unset, or any value other than `false`, behaves like the always-on default); set to `false` to skip starting the alert engine entirely — `server.js` checks this before calling `alertEngine.start()` |
| `ALERTS_RULES_PATH` | `./data/alertRules.json` | Where alert rule definitions are persisted (write-through JSON). On first-ever run (no file yet), seeds from `config/defaultAlertRules.json` instead |
| `DISCORD_ENABLED` | `true` | Both this and `DISCORD_WEBHOOK_URL` are required for Discord notifications to register |
| `DISCORD_WEBHOOK_URL` | *(none)* | Discord Incoming Webhook URL |
| `SLACK_ENABLED` | `true` | Both this and `SLACK_WEBHOOK_URL` are required for Slack notifications to register |
| `SLACK_WEBHOOK_URL` | *(none)* | Slack Incoming Webhook URL |
| `EMAIL_ENABLED` | `false` | This plus `EMAIL_SMTP_HOST` and `EMAIL_TO` are required for email notifications to register |
| `EMAIL_SMTP_HOST` | *(none)* | SMTP server hostname |
| `EMAIL_SMTP_PORT` | `587` | SMTP server port |
| `EMAIL_SMTP_SECURE` | `false` | Use implicit TLS (`true` for port 465-style connections) |
| `EMAIL_SMTP_USER` / `EMAIL_SMTP_PASS` | *(none)* | Optional SMTP auth — only used if **both** are set (some internal relays don't require auth) |
| `EMAIL_FROM` | `alerts@sndhome.local` | From address on outgoing alert emails |
| `EMAIL_TO` | *(none)* | Recipient address |
| `WEBHOOK_ENABLED` | `false` | Both this and `WEBHOOK_URL` are required for the generic webhook notifier to register |
| `WEBHOOK_URL` | *(none)* | Any HTTP endpoint to receive the raw alert JSON |
| `WEBHOOK_SECRET` | *(none)* | If set, signs the request body with HMAC-SHA256, sent as `X-SND-Signature` |
| `LAN_DEVICES_PATH` | `./data/lanDevices.json` | Where the known-device ledger (`lan/deviceStore.js`) is persisted |
| `LAN_SCAN_CIDR` | *(auto-detected)* | Override the subnet `lan/lanEngine.js` scans (e.g. `192.168.1.0/24`). Auto-detection (`lan/lanScanner.js`'s `detectLocalSubnet()`) picks the first non-internal IPv4 interface from `os.networkInterfaces()`, which can be the wrong one on a host with more than one active interface (VPN, a Docker virtual bridge, multiple NICs) — devices on the real LAN then never enter the scanned IP range at all. If the reported device count doesn't match reality, check for other active interfaces before assuming it's a detection bug |

> Recommend testing the email notifier against a sandbox SMTP provider (e.g. [Ethereal](https://ethereal.email), Mailtrap) rather than a real inbox.

You can also override any variable inline without a `.env` file:

```bash
PORT=4000 npm start
```

### 🐳 Docker

```bash
cp .env.example .env   # same as the native install above
docker compose up
```

**Read this before assuming `network_mode: host` (the compose file's default) gives you LAN parity — on a Mac, it doesn't, and the container won't even be reachable from your own machine. On genuine Linux, it does, and this has now been measured, not just reasoned about.** `docker-compose.yml` was originally written assuming "host" mode meant real access to the host's LAN, the same way it does when this app runs natively. Real testing (via [Colima](https://github.com/abiosoft/colima), a CLI Docker runtime for macOS) found that's only true on genuine Linux — every Mac-based Docker runtime (Colima, and Docker Desktop too, given the same underlying VM architecture) runs containers inside an intermediary Linux VM, and "host" networking there means *the VM's* network, not your Mac's. A follow-up run on an actual Linux Mint machine (no VM layer) then confirmed the Linux side of that claim directly:

| Environment / mode | System monitoring & alerting | LAN Device Monitoring | Reachable at `localhost:3000` from your machine? |
|---|---|---|---|
| **Genuine Linux host, `network_mode: host`** | ✅ Full | ✅ **Full — measured, not assumed.** `docker exec ... arp -an` inside the container was byte-for-byte identical to the bare host's own `arp -an` (12/12 entries matched) on a real Linux Mint machine with no VM in between; `GET /api/lan/status` tracked the real LAN (`knownDeviceCount: 12, onlineCount: 13–14` across several scan cycles, the same real network the native Mac process was concurrently reporting `14/14` for) | ✅ Yes — `curl http://localhost:3000/api/health` against the host's own `localhost` worked immediately, no VM boundary to cross |
| **macOS (Colima or Docker Desktop), `network_mode: host`** | ✅ Full | ❌ **Sees the VM's own virtual subnet, not your real LAN.** Measured on a real Mac with 12 real devices online: the containerized app reported `onlineCount: 2, knownDeviceCount: 1` — Colima's own `192.168.5.0/24` VM network, confirmed via `docker exec ... ip addr show` (`eth0: 192.168.5.1/24`) — while the native (non-Docker) process on the same machine at the same moment correctly reported all 12 | ❌ **No.** `curl http://localhost:3000` fails outright (verified by stopping the native process and confirming the connection then actually drops) — the VM's "host" network isn't forwarded back to the Mac for this mode |
| **Any platform, default bridge** (`ports:` mapping, in the compose file's comments) | ✅ Full — confirmed on genuine Linux via the mapped port (`curl http://localhost:3001/api/health`/`/api/system` both succeeded from the host) | ❌ **Not "zero devices" — the scan refuses to run at all.** Measured on the same Linux Mint host: the container's auto-detected interface is Docker's own bridge, `eth0: 172.17.0.2/16` — a full `/16`, 65,534 usable hosts — which trips `lan/lanScanner.js`'s own `MAX_HOSTS` (1024) safety cap outright. `GET /api/lan/status` returns `knownDeviceCount: 0, onlineCount: 0, lastError: "Refusing to enumerate 65534 hosts for 172.17.0.0/16 (exceeds the 1024-host safety cap)"` — the scan never starts, rather than starting and finding nothing | ✅ Yes (that's what the `ports:` mapping is for) — confirmed above |
| **Genuine Linux host, `macvlan` network** *(not in `docker-compose.yml` — opt-in, self-configured)* | ✅ Full — but not from the Docker host itself, see next column | ✅ **Full — measured.** `docker network create -d macvlan --subnet=<your LAN> --gateway=<your gateway> -o parent=<wired NIC> ...`, then `docker run --network <name> --ip <a free LAN IP> ...` gives the container its own MAC/IP directly on the real LAN segment, no NAT or virtual bridge involved. From another machine on the LAN, `GET /api/lan/status` returned real data (`knownDeviceCount: 13, onlineCount: 15`), and `docker exec ... arp -an` matched the same real neighbors seen in the `network_mode: host` run | ⚠️ **From other LAN devices, yes — from the Docker host itself over its macvlan's own parent interface, no.** This is a standard Linux kernel restriction (a macvlan parent interface and its own macvlan children can't exchange traffic directly), not a bug: `curl --interface <parent NIC> http://<container-ip>:3000/api/health` timed out from the host, while the same `curl` from any *other* NIC the host has on that LAN succeeded immediately. A single-NIC host needs the standard macvlan-shim workaround to reach its own container's dashboard |

**In practice, on macOS:** use default bridge mode (comment out `network_mode: host` in `docker-compose.yml`, uncomment the `ports:` block) if you want to reach the dashboard and use system monitoring + alerting — LAN Device Monitoring will report zero devices either way on a Mac, so `host` mode buys you nothing there except losing `localhost` access to your own dashboard. `network_mode: host` is only worth using on an actual Linux machine — and on Linux it's the recommended default, confirmed above rather than merely assumed. `macvlan` is a real alternative on Linux if you specifically need the dashboard to be reachable at its own LAN IP (not just via the Docker host's), at the cost of the host-reachability caveat above and setting it up yourself — not shipped in `docker-compose.yml` given this project's "no build step, no bundler" preference for keeping the default path simple. On a host with more than one active network interface, `LAN_SCAN_CIDR` (see the environment variable table above) is the escape hatch if auto-detection picks the wrong one inside the container — relevant on Linux, moot on macOS until the VM-networking gap above is addressed some other way.

`data/` is bind-mounted (`./data:/app/data`) so alert rules and the LAN device ledger survive a `docker compose down && docker compose up`. See [`PHASE6_DOCKER_PLAN.md`](PHASE6_DOCKER_PLAN.md) for the full design rationale and the empirical findings above in more detail.

### ☁️ Cloudflare Tunnel

Expose your dashboard to the public internet without port-forwarding, a static IP, or opening any inbound firewall rule — `cloudflared` connects *outbound* to Cloudflare's edge, so nothing needs to be reachable from the internet on your router at all. Fully opt-in and additive: skip this section entirely and nothing about your setup changes.

```bash
cloudflared tunnel login                    # one-time, opens a browser to authenticate
cloudflared tunnel create snd-home          # creates the tunnel
# In the Cloudflare Zero Trust dashboard (Networks > Tunnels), connect the
# new tunnel to a public hostname, pointed at http://localhost:3000 (or your
# PORT). Its "Docker" install method shows a `tunnel run --token <token>`
# command -- copy just the token into .env's CLOUDFLARE_TUNNEL_TOKEN.
docker compose --profile tunnel up -d       # starts snd-home AND cloudflared
```

> ⚠️ **A tunnel is not authentication.** It gets traffic to your origin, nothing more — anyone who reaches your tunnel hostname reaches SND@HOME exactly as if they were on your LAN. `API_KEY` (see [Authentication](#-api) above) still only gates mutating alert/notifier endpoints and all of `/api/lan/*` — every other `GET` endpoint (system stats, alert rules/history, health) stays public. **Before relying on this beyond casual/trusted use, add a Cloudflare Access policy** (Zero Trust > Access > Applications — email OTP, Google/GitHub SSO, IP allowlists) in front of the tunnel hostname. This authenticates at Cloudflare's edge, before a request ever reaches your server — strictly stronger than app-level auth for this purpose, and doesn't require distributing an API key to anyone who needs read access.

The `cloudflared` service in `docker-compose.yml` is off by default — a plain `docker compose up` never starts it, only `docker compose --profile tunnel up` does — and runs with `network_mode: host` just like `snd-home` itself, reaching it at `localhost:$PORT` the same way a local `curl` already does. See [`PHASE6_CLOUDFLARE_TUNNEL_PLAN.md`](PHASE6_CLOUDFLARE_TUNNEL_PLAN.md) for the full design rationale, including why the existing auth scoping was deliberately left unchanged rather than extended to cover this.

---

## 💻 Usage

Once the server is running, open your browser to:

```
http://localhost:3000
```

You'll see the live dashboard: CPU/memory/disk usage with progress bars, host info (hostname, IP, uptime), and four trend charts (CPU, memory, disk, network throughput) that redraw every 3 seconds from the polling history.

Prefer raw data? Hit the JSON API directly — see below.

```bash
curl http://localhost:3000/api/system | jq
```

Stop the server with `Ctrl+C` — it shuts down the background poller cleanly before exiting.

### Periodic LAN status check (cron)

`lan/lanEngine.js` scans on its own 2-minute timer, but only while the server process is up, and only reports what it finds through the API — nothing watches it from the outside. `scripts/check-lan-status.js` is a small, standalone Node script for that: it polls `GET /api/lan/status` and appends one line to `data/lan-status-check.log` (gitignored, like the other local data files) — `OK ...` with the current counts on success, `ERROR ...` if the server didn't respond at all (down, crashed, hung) or returned something unexpected. Kept as an external check specifically so it still records "the server is unreachable" when the server itself can't (an in-process alert rule can't do that).

Register it with cron to run every 5 minutes:

```bash
crontab -e
```

```cron
*/5 * * * * cd /path/to/SND_HOME && /usr/local/bin/node scripts/check-lan-status.js >> data/lan-status-check-cron-stderr.log 2>&1
```

(Use the absolute path to `node` — `which node` — since cron's `PATH` is minimal and won't necessarily include it.) The `>> ... 2>&1` redirect only ever catches something going wrong in the script itself (a crash before it gets to write its own log); the script's normal output, including failures reaching the server, goes to `data/lan-status-check.log`.

---

## 📡 API

All endpoints are served from the running Express app; only endpoints that exist in `server.js` are documented here.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Plain-text landing route (server up check) |
| `GET` | `/api/system` | Returns the latest cached system snapshot; runs a fresh collection if the cache is still empty (e.g. right after startup) |
| `GET` | `/api/system/latest` | Returns the cached snapshot only — `503` if the engine hasn't collected yet |
| `GET` | `/api/system/history?limit=N` | Returns up to `N` recent history points (default `120`) used for trend charts |
| `GET` | `/api/monitor/status` | Returns the polling engine's own status (running, interval, last update, uptime) |
| `GET` | `/api/health` | Simple liveness check — `{ "status": "ok" }` |
| `GET` | `/api/alerts/rules` | List all alert rules with their current runtime state |
| `GET` | `/api/alerts/rules/:id` | Get a single rule + its runtime state |
| `POST` | `/api/alerts/rules` | Create a new rule (body validated against the rule schema) |
| `PUT` | `/api/alerts/rules/:id` | Update an existing rule (partial merge) |
| `DELETE` | `/api/alerts/rules/:id` | Delete a rule (its runtime state is discarded too) |
| `GET` | `/api/alerts/active` | List only rules currently `FIRING`, `DOWN`, or `RECOVERING` |
| `GET` | `/api/alerts/history?limit=N` | Recent alert state-transition events (default `100`) |
| `POST` | `/api/alerts/rules/:id/test` | Fire a synthetic `[TEST]` alert for one rule through its notifiers, without needing a real breach |
| `GET` | `/api/alerts/engine/status` | Alert engine's own status (running, rule count, active alert count, last evaluated) |
| `GET` | `/api/notifiers` | List all known notifier channels and whether each is live-configured |
| `POST` | `/api/notifiers/:name/test` | Send a `[TEST]` message through one specific notifier channel |
| `GET` | `/api/lan/devices` | List every known device in the LAN ledger (online and offline) |
| `GET` | `/api/lan/devices/:mac` | Get a single device by MAC address |
| `PATCH` | `/api/lan/devices/:mac` | Set or clear (`nickname: null`) a device's display nickname |
| `GET` | `/api/lan/status` | LAN scan engine status (running, scan interval, known/online device counts, last scan time) |

> 🔒 **Authentication is opt-in.** The mutating alert/notifier endpoints (`POST`/`PUT`/`DELETE`) are unauthenticated by default — fine for a single-user homelab on a trusted network. Set `API_KEY` in `.env` to require `Authorization: Bearer <API_KEY>` on those endpoints (`middleware/auth.js`); leave it unset to keep the previous, no-auth behavior. Recommended before exposing this server beyond localhost/your own LAN. Read-only `GET` endpoints are never gated — **except `/api/lan/*`, which is gated as a whole (including its `GET` routes)** when `API_KEY` is set: a list of devices on your network is more sensitive than a CPU percentage, so every route under `/api/lan` is protected together rather than only its mutating ones. See [`PHASE5_PLAN.md`](PHASE5_PLAN.md) for the history of this decision.

<details>
<summary><code>GET /api/system</code> — example response</summary>

```json
{
  "status": "ok",
  "hostname": "imac.local",
  "platform": "darwin",
  "cpu": { "usage": 12.4, "cores": 8 },
  "memory": { "used": 8589934592, "total": 17179869184, "percent": 50.0 },
  "disk": { "used": 214748364800, "total": 499963174912, "percent": 43.0 },
  "network": {
    "interfaces": [{ "name": "en0", "address": "192.168.1.42", "family": "IPv4", "internal": false }],
    "localIp": "192.168.1.42",
    "rxBytes": 1048576000,
    "txBytes": 524288000
  },
  "load": [1.23, 1.10, 0.98],
  "uptime": 349201,
  "timestamp": "2026-08-07T09:35:22.000Z"
}
```
</details>

<details>
<summary><code>GET /api/system/history?limit=2</code> — example response</summary>

```json
{
  "status": "ok",
  "count": 2,
  "interval": 5000,
  "data": [
    {
      "timestamp": "2026-08-07T09:35:12.000Z",
      "cpu": { "usage": 10.1 },
      "memory": { "percent": 49.8 },
      "disk": { "percent": 43.0 },
      "network": { "rxBytes": 1047500000, "txBytes": 523700000 }
    },
    {
      "timestamp": "2026-08-07T09:35:17.000Z",
      "cpu": { "usage": 12.4 },
      "memory": { "percent": 50.0 },
      "disk": { "percent": 43.0 },
      "network": { "rxBytes": 1048576000, "txBytes": 524288000 }
    }
  ]
}
```
</details>

<details>
<summary><code>GET /api/monitor/status</code> — example response</summary>

```json
{
  "running": true,
  "interval": 5000,
  "lastUpdated": "2026-08-07T09:35:22.000Z",
  "uptime": 612
}
```
</details>

<details>
<summary><code>GET /api/alerts/rules</code> — example response</summary>

```json
{
  "status": "ok",
  "data": [
    {
      "id": "disk-root-critical",
      "name": "Root disk usage critical",
      "metric": "disk.percent",
      "operator": ">=",
      "threshold": 90,
      "clearThreshold": 80,
      "duration": 30,
      "hysteresis": 60,
      "cooldown": 1800,
      "severity": "critical",
      "channels": [],
      "enabled": true,
      "runtime": {
        "state": "DOWN",
        "value": 91.4,
        "since": "2026-08-07T09:58:12.000Z",
        "lastNotifiedAt": "2026-08-07T09:58:42.000Z"
      }
    }
  ]
}
```
</details>

<details>
<summary><code>GET /api/alerts/engine/status</code> — example response</summary>

```json
{
  "running": true,
  "rulesCount": 3,
  "activeAlertsCount": 1,
  "lastEvaluatedAt": "2026-08-07T09:58:42.000Z"
}
```
</details>

<details>
<summary><code>GET /api/notifiers</code> — example response</summary>

```json
{
  "status": "ok",
  "data": [
    { "name": "discord", "configured": true },
    { "name": "slack", "configured": false },
    { "name": "email", "configured": false },
    { "name": "webhook", "configured": true }
  ]
}
```
</details>

<details>
<summary><code>GET /api/lan/devices</code> — example response</summary>

```json
{
  "status": "ok",
  "data": [
    {
      "mac": "aa:bb:cc:dd:ee:ff",
      "ip": "192.168.1.1",
      "vendor": "NETGEAR",
      "nickname": "Living Room Router",
      "online": true,
      "respondedToPing": true,
      "inArpTable": true,
      "firstSeenAt": "2026-08-10T09:00:00.000Z",
      "lastSeenAt": "2026-08-11T13:02:00.000Z"
    }
  ]
}
```
</details>

<details>
<summary><code>GET /api/lan/status</code> — example response</summary>

```json
{
  "running": true,
  "interval": 120000,
  "lastUpdated": "2026-08-11T13:02:00.000Z",
  "lastError": null,
  "uptime": 3612,
  "knownDeviceCount": 14,
  "onlineCount": 11,
  "unresolvedMacCount": 2
}
```

`unresolvedMacCount` is how many devices this scan found (via ping and/or ARP) but couldn't resolve a MAC address for — they count toward `onlineCount` but not `knownDeviceCount`, since `lan/deviceStore.js` deliberately doesn't ledger a device with no stable identifier to key it by (see that file's header comment). If this is consistently non-zero (not just an occasional device that genuinely blocks ARP), also check `LAN_SCAN_CIDR` above.

> 🔧 **Fixed root cause of under-detection:** `lan/lanScanner.js` used to call plain `arp -a`, which tries to resolve every IP to a hostname via reverse DNS. On a real machine tested against, with no reachable reverse-DNS resolver for private addresses, that single call took **13 seconds** — far past `DEFAULT_ARP_TIMEOUT_MS` (2s) — so it was killed by the timeout on every scan and `readArpTable()` always fell back to an empty map, silently leaving every online device's MAC unresolved (`unresolvedMacCount` equal to `onlineCount`, `knownDeviceCount` stuck at 0). Now calls `arp -an` (numeric, no hostname resolution) instead — same call took **14ms** and returned correct data. If you're on an older version and see `onlineCount` far above `knownDeviceCount`, this is almost certainly why.
</details>

> 🧭 **Feeds into the Alert Engine, too.** `collectors/lanCollector.js` registers into the same `collectorRegistry` as CPU/memory/disk/network, exposing each known device on `/api/system` as `lan.devices.<mac_with_underscores_instead_of_colons>.online` (`0`/`1`). That means a per-device "went offline" alert rule (e.g. `{ "metric": "lan.devices.aa_bb_cc_dd_ee_ff.online", "operator": "<", "threshold": 1 }`) works today with zero changes to `alertEngine.js`/`ruleEvaluator.js` — it's the same dot-path `resolveMetric()` mechanism every other metric alert already uses.

---

## 📁 Project Structure

```
SND_HOME/
├── collectors/                  # Metric collector plugins (name + collect())
│   ├── cpuCollector.js           # CPU usage % (sampled) + core count
│   ├── memoryCollector.js        # Used / total / percent memory
│   ├── diskCollector.js          # Used / total / percent disk (via df -k /)
│   ├── networkCollector.js       # Interfaces, local IP, rx/tx bytes (via netstat -ib)
│   └── lanCollector.js           # Reads lanEngine's cache, exposes lan.devices.<mac> for alert rules
├── monitor/
│   ├── collectorRegistry.js      # Registers collectors, runs collectAll()
│   ├── monitorEngine.js          # EventEmitter-based background polling loop (5s)
│   └── historyStore.js           # In-memory ring buffer (720 points) for trend data
├── lan/                          # LAN device discovery — independent 2-minute timer, not part of the 5s poll loop
│   ├── lanScanner.js             # Subnet detection, ping sweep, arp/ip-neigh MAC lookup, OUI vendor resolution
│   ├── lanEngine.js              # EventEmitter-based scan loop (mirrors monitorEngine.js's pattern)
│   ├── deviceStore.js            # CRUD + JSON-file persistence for the known-device ledger
│   └── ouiLookup.js              # Static MAC-prefix -> vendor name lookup (config/ouiPrefixes.json)
├── alerts/
│   ├── ruleEvaluator.js          # Pure state-machine transition logic (no I/O)
│   ├── ruleStore.js              # CRUD + JSON-file persistence for alert rules
│   ├── alertEngine.js            # Subscribes to MonitorEngine 'update', drives evaluation
│   ├── alertHistoryStore.js      # Ring buffer of alert state-transition events
│   └── notifierRegistry.js       # Notifier plugin registry (register/list/dispatch)
├── notifiers/                    # Notification plugins (name + configured() + notify())
│   ├── discordNotifier.js
│   ├── slackNotifier.js
│   ├── emailNotifier.js          # Uses nodemailer
│   └── webhookNotifier.js        # Optional HMAC-SHA256 request signing
├── middleware/
│   └── auth.js                   # Opt-in Bearer-token auth (requireAuth), gated on API_KEY
├── routes/
│   ├── system.js                 # /api/system, /api/health, /api/system/*
│   ├── monitor.js                # /api/monitor/status
│   ├── alerts.js                 # /api/alerts/* (rules CRUD, active, history, test, status)
│   ├── notifiers.js              # /api/notifiers/*
│   └── lan.js                    # /api/lan/* (device ledger, nicknames, scan status) — entire router requires auth when set
├── config/
│   ├── defaultAlertRules.json    # Seed rules loaded on first-ever run
│   └── ouiPrefixes.json          # Static MAC-prefix -> vendor name table used by lan/ouiLookup.js
├── data/                         # Runtime-persisted state (gitignored, created at runtime)
│   ├── .gitkeep
│   ├── alertRules.json           # Alert rule definitions
│   └── lanDevices.json           # Known LAN device ledger
├── public/                       # Static dashboard, served by express.static
│   ├── index.html                # Dashboard markup
│   ├── app.js                    # Fetch loop, rendering, Canvas line charts
│   └── style.css                 # Dark, GitHub-inspired theme
├── server.js                     # Express app, routes, startup/shutdown
├── .env.example                  # Documents every supported environment variable
├── package.json
└── package-lock.json
```

---

## 🔭 Future Vision

SND@HOME's long-term goal is to become a genuinely **AI-powered, self-hosted infrastructure monitoring platform** — not another dashboard you have to babysit.

The collector-plugin and event-driven engine design already in place (`collectorRegistry.register()`, `MonitorEngine`'s `update`/`error` events) exists specifically so the next layers can be added *without* rewriting the core:

- **Self-hosted first** — your metrics, your box, no third-party cloud dependency.
- **Alerting as a subscriber** — proven out in Phase 5: `AlertEngine` is just another listener on `MonitorEngine`'s `update` event, added without touching `monitorEngine.js` at all. Notifier channels follow the same pattern one level down — `notifierRegistry.dispatch()` fans out to `discordNotifier`/`slackNotifier`/`emailNotifier`/`webhookNotifier` the same way `collectorRegistry.collectAll()` fans out to the metric collectors.
- **AI-assisted insight** — once history accumulates, anomaly detection and natural-language health summaries ("your disk usage has been trending up 3%/day") become possible on top of the existing `HistoryStore`, without changing how metrics are collected.
- **Beyond one box** — the app itself already runs unmodified on Raspberry Pi hardware (verified, [`PHASE6_RASPBERRY_PI_PLAN.md`](PHASE6_RASPBERRY_PI_PLAN.md)); multi-node aggregation across several such boxes is the next layer, extending the same collector/engine model across a whole home network.

Alerting is the first of these proven out end-to-end; AI-assisted insight and multi-node aggregation don't exist yet — they're the direction the architecture is deliberately built to support next. See [Roadmap](#️-roadmap) for the concrete, incremental path there.

---

## 🤝 Contributing

Contributions are very welcome — this project is still early, and there's a lot of surface area to help with.

1. **Fork** the repository and create a branch off `main`: `git checkout -b feat/your-feature`
2. **Keep plugins self-contained** — a new metric should be a new file in `collectors/` exporting `{ name, collect() }` and registered in `collectorRegistry.js`; a new notification channel should be a new file in `notifiers/` exporting `{ name, configured(), notify(alert) }` and registered in `notifierRegistry.js`. Avoid touching `monitorEngine.js`/`alertEngine.js` unless you're changing the core engine model itself.
3. **Match the existing style** — CommonJS modules, small focused functions, comments only where the *why* isn't obvious from the code.
4. **Run the test suite** — `npm test` runs the full `node:test` suite (state machine, persistence, notifiers, HTTP routes). Add tests alongside new code (`x.js` → `x.test.js`) rather than relying on manual verification.
5. **Open a PR** against `main` with a clear description of what changed and why.

Found a bug or have an idea? Open an issue — even rough ones are useful.

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for the full text.

---

<div align="center">

Built for home labs that deserve better than a blinking cursor and a prayer.

**⌂ SND@HOME**

</div>
