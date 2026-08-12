# Phase 6 Implementation Plan — Cloudflare Tunnel Integration

**Status:** Implemented (config + docs). Live reachability from the public internet is deferred, pending a real Cloudflare account/domain — see Verification below.
**Depends on:** Docker support (`PHASE6_DOCKER_PLAN.md`), already implemented and fully verified. This plan reuses `docker-compose.yml`'s existing `network_mode: host` pattern and the `Dockerfile`'s existing `HEALTHCHECK`.
**Scope:** Phase 6 in README's Roadmap lists four items — Docker support, Cloudflare Tunnel integration, a Raspberry Pi agent, and multi-node monitoring. This document covers **Cloudflare Tunnel integration only**, the second of the four. `PHASE6_DOCKER_PLAN.md`'s own Scope section anticipated this: "The other three are not addressed here and may each want their own plan document later." The other two remain unaddressed here.

---

# Objectives

1. Let an operator expose their SND@HOME dashboard to the public internet without port-forwarding, static IP, or opening any inbound firewall rule — the whole point of a Cloudflare Tunnel (outbound-only connection from `cloudflared` to Cloudflare's edge).
2. Keep this fully opt-in and additive: an operator who never touches this should see zero behavior change. No new routes, no new required env vars, no change to any existing default.
3. Don't let "you can now reach this from the internet" quietly become "and it's unauthenticated" — the existing `API_KEY` auth (`middleware/auth.js`) only gates mutating alert/notifier endpoints and all of `/api/lan/*` (README:360's already-documented, deliberate Phase 5 decision). Say this loudly, in the same places an operator would look when wiring the tunnel up, rather than relying on them to already know it.
4. Reuse what already exists rather than inventing new mechanism: the `Dockerfile`'s `HEALTHCHECK` (already hits `GET /api/health`), `docker-compose.yml`'s `network_mode: host` pattern, and the project's existing `<SERVICE>_ENABLED`-style opt-in conventions (Discord/Slack/Email/Webhook notifiers) — here, a Compose `profiles:` gate plays the same role, since there's no app code to put an enabled-flag check in.

**Non-objectives (deferred):** any application code change (nothing in `server.js` needs to know a tunnel exists); changing `middleware/auth.js`'s existing gating scope (a deliberate Phase 5 decision, not reopened here — see Central design decision); configuring Cloudflare Access policies themselves (done in the Cloudflare dashboard, outside this repo — only documented as the recommendation); native/systemd `cloudflared` install instructions for non-Docker operators (the Compose path is the one shipped, matching how Docker itself became "the supported path" while native `npm start` remains primary; can be added later if requested).

---

# Central design decision: security posture

Cloudflare Tunnel is not an authentication mechanism — `cloudflared` gets inbound traffic to the origin without opening a port, but anyone who reaches the tunnel's public hostname reaches SND@HOME exactly as if they were on the LAN, subject to whatever auth the app itself enforces. That raises a real question this plan can't route around: does exposing the dashboard to the *public internet* change the calculus behind Phase 5's existing auth scoping?

Today, `API_KEY` (when set) gates:
- All mutating `/api/alerts` and `/api/notifiers` endpoints (`POST`/`PUT`/`DELETE`)
- Every route under `/api/lan/*`, including its `GET` routes (a device list — MACs, IPs, nicknames — was judged more sensitive than a CPU percentage, per README:360)

It does **not** gate: `GET /api/system`, `GET /api/system/history`, `GET /api/monitor/status`, `GET /api/health`, `GET /api/alerts/rules`, `GET /api/alerts/active`, `GET /api/alerts/history`. These stay public even with `API_KEY` set — a deliberate, already-documented Phase 5 decision (README:360), not an oversight this plan is discovering.

**Two options were considered:**

| Option | What it does | Trade-off |
|---|---|---|
| **Extend `requireAuth` to cover all `/api/*` routes when `API_KEY` is set** | Closes the GET-endpoint gap at the app layer | Reopens and changes a decision Phase 5 made deliberately and documented explicitly; every existing LAN-only user who has `API_KEY` set today would suddenly need a Bearer token for dashboard reads they didn't need before — a real behavior change with no code-level way to scope it to "only when tunneled" |
| **Leave `middleware/auth.js` unchanged; document Cloudflare Access as the recommended real access-control layer** | Auth happens at Cloudflare's edge (Zero Trust > Access > Applications — email OTP, Google/GitHub SSO, IP allowlists, etc.), before traffic ever reaches the origin at all | Requires the operator to set up Access separately in the Cloudflare dashboard; app-level GET endpoints remain unauthenticated *if* Access isn't configured — the tunnel alone is not enough |

**Decided (confirmed with the user before implementation): leave `middleware/auth.js` unchanged, document Cloudflare Access as the strongly-recommended layer.** Rationale: Phase 5's scoping was a considered decision made with full context, not a gap this integration happens to expose — reopening it as a side effect of an unrelated feature (tunneling) risks a worse outcome than either option alone (a rushed auth change bolted onto a networking feature). Cloudflare Access is *also* strictly stronger than app-level Bearer-token auth for this use case: it authenticates before the request reaches SND@HOME at all, rather than after, and doesn't require distributing an API key to anyone who needs read access. The cost is that this plan cannot claim "the tunnel is safe by default" — it has to say clearly that it isn't, and point at the actual fix. That's the approach taken in `docker-compose.yml`'s new comments, `.env.example`'s new block, and the README section below.

---

# Architecture

No new files beyond this plan document and the `docker-compose.yml`/`.env.example` additions — `cloudflared` is an external, prebuilt Cloudflare image; there's no Dockerfile of our own to write for it.

```mermaid
graph LR
    Internet["Public internet"] -->|HTTPS| CFEdge["Cloudflare edge"]
    CFEdge -->|Access policy<br/>(recommended,<br/>configured in dashboard)| CFEdge
    CFEdge -->|outbound-only tunnel| Cloudflared["cloudflared container<br/>(network_mode: host)"]
    Cloudflared -->|http://localhost:PORT| App["snd-home container<br/>(network_mode: host)"]
```

`cloudflared` initiates the connection *outbound* to Cloudflare — no inbound port is ever opened on the operator's router/firewall. The tunnel token (`CLOUDFLARE_TUNNEL_TOKEN`) is the only credential involved on this side; the hostname-to-tunnel routing and any Access policy live entirely in the Cloudflare dashboard, not in this repo.

---

# Docker Compose service

Added to `docker-compose.yml`, alongside the existing `snd-home` service:

```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: snd-home-tunnel
    network_mode: host
    restart: unless-stopped
    profiles: ["tunnel"]
    command: tunnel run --token ${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on:
      snd-home:
        condition: service_healthy
```

- **`network_mode: host`** — mirrors `snd-home`'s own default. `cloudflared` reaches the app at `http://localhost:$PORT`, the same way a plain `curl` from the host already does (README's existing Docker section) — no container-to-container Compose network to design, no service-name DNS to get right.
- **`profiles: ["tunnel"]`** — the actual opt-in gate. A plain `docker compose up` never starts this service; only `docker compose --profile tunnel up` does. This is the Compose-native equivalent of the project's existing `<SERVICE>_ENABLED` pattern (Discord/Slack/Email/Webhook notifiers each self-gate on an env var) — there's no application code for `cloudflared` to check an env var *in*, so the gate lives at the Compose layer instead.
- **`depends_on: condition: service_healthy`** — reuses the `Dockerfile`'s existing `HEALTHCHECK` instruction (already hits `GET /api/health` on a 30s interval) rather than inventing a second health signal. `cloudflared` won't start routing real traffic until Docker reports `snd-home` as healthy.
- **Token-run method**, not the config-file method (`cloudflared tunnel run` with a mounted `config.yml` + `credentials.json`) — one env var (`CLOUDFLARE_TUNNEL_TOKEN`), no extra files to bind-mount or keep in sync. Matches the project's existing "no build step, no bundler" homelab-simplicity philosophy (README's Tech Stack), already the deciding factor behind the Dockerfile's own single-stage build.

---

# Setup steps (operator-facing, also mirrored in README)

1. [Install `cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) locally (or use the Cloudflare dashboard directly — both work) and authenticate: `cloudflared tunnel login`.
2. Create a tunnel: `cloudflared tunnel create snd-home`.
3. In the Cloudflare Zero Trust dashboard (Networks > Tunnels), connect the new tunnel to a public hostname (e.g. `snd-home.yourdomain.com`) pointed at `http://localhost:3000` (or whatever `PORT` is set to).
4. From the tunnel's "Docker" install method in the dashboard, copy just the token portion of the shown `cloudflared tunnel run --token <token>` command into `.env`'s `CLOUDFLARE_TUNNEL_TOKEN`.
5. `docker compose --profile tunnel up -d` — starts both `snd-home` and `cloudflared`.
6. **Strongly recommended before step 5 is "done" in any real sense:** in the same dashboard, add an Access policy (Access > Applications) in front of the new hostname, requiring at minimum an email OTP or SSO login. Without this, anyone who discovers or guesses the hostname reaches the dashboard's public endpoints (see Central design decision above for exactly which ones).

---

# Estimates

| | |
|---|---|
| **Total tasks** | 4: `docker-compose.yml` service, `.env.example` block, this plan document, README section — no stretch items, no application code |
| **Total implementation time** | ~1–1.5 hours — smaller than Docker support itself, since there's no Dockerfile/image to build and no networking-mode ambiguity to resolve empirically (Cloudflare handles routing entirely outside this repo) |
| **Risk** | **Low for the mechanism, real for the security framing.** The Compose service itself is low-risk (an off-by-default, well-isolated sidecar reusing an existing health check). The actual risk this plan manages is an operator assuming "tunnel = secure" — mitigated by putting the Cloudflare Access recommendation in three places an operator would actually see it (`docker-compose.yml` comments, `.env.example`, README), not just this plan document. |
| **Complexity** | **Low.** No new application code, no new persisted state, no new test surface — `npm test` is unaffected by design (see Verification). |

---

# Verification

**Verifiable now, without live Cloudflare credentials:**
- `docker compose config` (or `docker compose --profile tunnel config`) parses the new service and confirms `profiles:` gating is recognized — a plain `docker compose config --services` (no `--profile` flag) does not list `cloudflared`.
- `npm test` — unaffected (356/356, no application code touched by this plan); confirms this integration is genuinely additive.
- Manual read-through of `docker-compose.yml`, `.env.example`, this document, and the new README section for internal consistency — no contradicting claims about what `API_KEY` does or doesn't gate.

**Explicitly deferred, not silently skipped:** actually running `cloudflared tunnel create`, connecting a real hostname, confirming the dashboard is reachable from the public internet, and confirming an Access policy actually blocks unauthenticated requests. All of this requires a real Cloudflare account and domain, not available in the session this was implemented in — the same category of gap as Phase 5's live Discord/Slack E2E test (`PHASE5_PLAN.md` Stage 8's 8.1/8.2, `README.md`'s Roadmap). Whoever has a real Cloudflare account can complete the "Setup steps" section above directly; no further code or config changes are anticipated to be needed first.

---

# Open decisions needing sign-off

None remaining — the one real design decision (security posture, above) was raised to and confirmed by the user before implementation began, the same process `PHASE6_DOCKER_PLAN.md`'s networking-mode decision went through.
