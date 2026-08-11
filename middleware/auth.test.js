// middleware/auth.test.js
// middleware/auth.js の requireAuth 単体テスト。実際のルーターへの配線
// (POST/PUT/DELETE のみ対象、GET は対象外)の検証は
// routes/alerts.test.js・routes/notifiers.test.js の "auth (opt-in)" ブロックが
// 別途担う — ここでは requireAuth 単体の判定ロジックのみを対象にする。
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const express = require("express");

const { requireAuth } = require("./auth");

const app = express();
app.get("/protected", requireAuth, (req, res) => res.json({ status: "ok" }));

afterEach(() => {
  delete process.env.API_KEY;
});

describe("requireAuth", () => {
  it("passes through when API_KEY is not set (opt-in default: unauthenticated)", async () => {
    delete process.env.API_KEY;
    const res = await request(app).get("/protected");
    assert.equal(res.status, 200);
  });

  it("401s when API_KEY is set and no Authorization header is sent", async () => {
    process.env.API_KEY = "secret-token";
    const res = await request(app).get("/protected");
    assert.equal(res.status, 401);
    assert.equal(res.body.status, "error");
  });

  it("401s when API_KEY is set and the token doesn't match", async () => {
    process.env.API_KEY = "secret-token";
    const res = await request(app).get("/protected").set("Authorization", "Bearer wrong-token");
    assert.equal(res.status, 401);
  });

  it("401s when the scheme isn't Bearer, even with the right token value", async () => {
    process.env.API_KEY = "secret-token";
    const res = await request(app).get("/protected").set("Authorization", "Basic secret-token");
    assert.equal(res.status, 401);
  });

  it("passes through when API_KEY is set and the Bearer token matches exactly", async () => {
    process.env.API_KEY = "secret-token";
    const res = await request(app).get("/protected").set("Authorization", "Bearer secret-token");
    assert.equal(res.status, 200);
  });
});
