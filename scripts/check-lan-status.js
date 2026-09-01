#!/usr/bin/env node
// scripts/check-lan-status.js
// Periodic external health check for the LAN scan engine, meant to be run
// via cron (see README's "Periodic LAN status check" section) -- separate
// from lan/lanEngine.js's own internal 2-minute scan loop. This just polls
// the already-running server's GET /api/lan/status from outside the
// process and appends one log line per run, so a regression like the
// `arp -a` reverse-DNS timeout fixed in dc1138f (every device silently
// losing its resolved MAC -- onlineCount and knownDeviceCount diverging)
// leaves a trail to find later instead of only being visible if someone
// happens to check by hand.
//
// Deliberately a standalone script, not a route or an alert rule: it needs
// to keep working (and recording that the server is unreachable) even when
// the server process itself is down, which an in-process alert rule
// couldn't do.
const http = require("http");
const fs = require("fs");
const path = require("path");
// server.js loads .env via `require("dotenv").config()` (cwd-relative), which
// happens to work under the documented crontab entry (`cd .../SND_HOME && ...`)
// but silently doesn't if this script is ever invoked with a different cwd.
// Resolve the path explicitly from __dirname instead, so PORT (and anything
// else in .env) is read correctly regardless of the caller's cwd -- this was
// the root cause of this script quietly checking the wrong port for however
// long .env's PORT has differed from the 3000 default (see data/lan-status-check.log's
// http_status=401 entries: those were a *different* app answering on 3000).
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const PORT = process.env.PORT || 3000;
const LOG_PATH = process.env.LAN_STATUS_CHECK_LOG_PATH || path.join(__dirname, "..", "data", "lan-status-check.log");
const REQUEST_TIMEOUT_MS = 5000;

function appendLog(line) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `${line}\n`, "utf8");
}

function timestamp() {
  return new Date().toISOString();
}

const req = http.get(`http://localhost:${PORT}/api/lan/status`, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
  let body = "";
  res.on("data", (chunk) => {
    body += chunk;
  });
  res.on("end", () => {
    if (res.statusCode !== 200) {
      appendLog(`${timestamp()} ERROR http_status=${res.statusCode} body=${body}`);
      process.exitCode = 1;
      return;
    }
    try {
      const status = JSON.parse(body);
      appendLog(
        `${timestamp()} OK running=${status.running} onlineCount=${status.onlineCount} ` +
          `knownDeviceCount=${status.knownDeviceCount} unresolvedMacCount=${status.unresolvedMacCount} ` +
          `lastUpdated=${status.lastUpdated} lastError=${status.lastError}`,
      );
    } catch (error) {
      appendLog(`${timestamp()} ERROR failed to parse response as JSON: ${error.message}`);
      process.exitCode = 1;
    }
  });
});

req.on("timeout", () => {
  req.destroy();
  appendLog(`${timestamp()} ERROR request timed out after ${REQUEST_TIMEOUT_MS}ms (server not responding)`);
  process.exitCode = 1;
});

req.on("error", (error) => {
  // Node 20+ can surface a connection-refused failure as an AggregateError
  // (IPv4/IPv6 happy-eyeballs) whose own .message is empty -- the useful
  // detail is on .code (e.g. "ECONNREFUSED") or nested in .errors.
  const reason = error.code || error.message || String(error);
  appendLog(`${timestamp()} ERROR ${reason} (server likely not running)`);
  process.exitCode = 1;
});
