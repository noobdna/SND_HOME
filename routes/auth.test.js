// routes/auth.test.js
// routes/auth.js の supertest 統合テスト。/api/auth/status の HTTPレイヤーを
// 対象とする -- 中身は process.env.API_KEY の有無を Boolean() で見るだけの
// 薄いルートなので、ここでの検証もそれで十分。
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const express = require("express");

const authRouter = require("./auth");

const app = express();
app.use("/api/auth", authRouter);

afterEach(() => {
  delete process.env.API_KEY;
});

describe("GET /api/auth/status", () => {
  it("returns { enforced: false } when API_KEY is unset (bare object, no envelope -- same convention as /api/monitor/status etc.)", async () => {
    delete process.env.API_KEY;
    const res = await request(app).get("/api/auth/status");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { enforced: false });
  });

  it("returns { enforced: true } when API_KEY is set", async () => {
    process.env.API_KEY = "secret-token";
    const res = await request(app).get("/api/auth/status");
    assert.deepEqual(res.body, { enforced: true });
  });

  it("never echoes the actual API_KEY value in the response", async () => {
    process.env.API_KEY = "super-secret-value-12345";
    const res = await request(app).get("/api/auth/status");
    assert.ok(!JSON.stringify(res.body).includes("super-secret-value-12345"));
  });
});
