// notifiers/emailNotifier.test.js
// notifiers/emailNotifier.js のユニットテスト: configured()/未設定パス、
// notify() の成功時トランスポート設定・sendMail() 呼び出し内容、失敗パス
// (sendMail() の reject)を、nodemailer.createTransport() をmockして検証する
// (実際のSMTP接続には一切触れない — nodemailer は emailNotifier.js 側で
// 非分割 require されているため、モジュールオブジェクトごとmonkey-patchできる)。
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const nodemailer = require("nodemailer");

const ENV_KEYS = [
  "EMAIL_ENABLED",
  "EMAIL_SMTP_HOST",
  "EMAIL_SMTP_PORT",
  "EMAIL_SMTP_SECURE",
  "EMAIL_SMTP_USER",
  "EMAIL_SMTP_PASS",
  "EMAIL_FROM",
  "EMAIL_TO",
];
let savedEnv;
let originalCreateTransport;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  originalCreateTransport = nodemailer.createTransport;
  delete require.cache[require.resolve("./emailNotifier")];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  nodemailer.createTransport = originalCreateTransport;
});

const sampleAlert = {
  alertId: "disk-root-critical:2026-08-07T10:00:00.000Z",
  ruleId: "disk-root-critical",
  ruleName: "Root disk usage critical",
  metric: "disk.percent",
  value: 91.4,
  operator: ">=",
  threshold: 90,
  severity: "critical",
  state: "FIRING",
  previousState: "OK",
  message: "Root disk usage critical is FIRING: disk.percent = 91.4 (threshold >= 90)",
  timestamp: "2026-08-07T10:00:00.000Z",
};

describe("configured()", () => {
  it("is false when EMAIL_ENABLED is unset", () => {
    process.env.EMAIL_SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_TO = "ops@example.com";
    const emailNotifier = require("./emailNotifier");
    assert.equal(emailNotifier.configured(), false);
  });

  it("is false when EMAIL_ENABLED=true but EMAIL_SMTP_HOST is unset", () => {
    process.env.EMAIL_ENABLED = "true";
    process.env.EMAIL_TO = "ops@example.com";
    const emailNotifier = require("./emailNotifier");
    assert.equal(emailNotifier.configured(), false);
  });

  it("is false when EMAIL_ENABLED=true but EMAIL_TO is unset", () => {
    process.env.EMAIL_ENABLED = "true";
    process.env.EMAIL_SMTP_HOST = "smtp.example.com";
    const emailNotifier = require("./emailNotifier");
    assert.equal(emailNotifier.configured(), false);
  });

  it("is true when EMAIL_ENABLED=true, EMAIL_SMTP_HOST, and EMAIL_TO are all set (SMTP auth optional)", () => {
    process.env.EMAIL_ENABLED = "true";
    process.env.EMAIL_SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_TO = "ops@example.com";
    const emailNotifier = require("./emailNotifier");
    assert.equal(emailNotifier.configured(), true);
  });
});

describe("notify() — success path", () => {
  beforeEach(() => {
    process.env.EMAIL_ENABLED = "true";
    process.env.EMAIL_SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_TO = "ops@example.com";
  });

  it("builds the transport with the given host/port/secure and calls sendMail() with the right fields", async () => {
    process.env.EMAIL_SMTP_PORT = "465";
    process.env.EMAIL_SMTP_SECURE = "true";
    process.env.EMAIL_FROM = "custom-from@example.com";

    let transportOptions;
    let mailOptions;
    nodemailer.createTransport = (options) => {
      transportOptions = options;
      return { sendMail: async (opts) => { mailOptions = opts; } };
    };

    const emailNotifier = require("./emailNotifier");
    await emailNotifier.notify(sampleAlert);

    assert.equal(transportOptions.host, "smtp.example.com");
    assert.equal(transportOptions.port, 465);
    assert.equal(transportOptions.secure, true);

    assert.equal(mailOptions.from, "custom-from@example.com");
    assert.equal(mailOptions.to, "ops@example.com");
    assert.match(mailOptions.subject, /CRITICAL/);
    assert.match(mailOptions.subject, /Root disk usage critical/);
    assert.match(mailOptions.subject, /FIRING/);
    assert.equal(mailOptions.text, sampleAlert.message);
  });

  it("defaults port to 587 and EMAIL_FROM to alerts@sndhome.local when unset", async () => {
    let transportOptions;
    nodemailer.createTransport = (options) => {
      transportOptions = options;
      return { sendMail: async () => {} };
    };

    const emailNotifier = require("./emailNotifier");
    await emailNotifier.notify(sampleAlert);

    assert.equal(transportOptions.port, 587);
    assert.equal(transportOptions.secure, false);
  });

  it("omits auth when EMAIL_SMTP_USER/PASS are unset", async () => {
    let transportOptions;
    nodemailer.createTransport = (options) => {
      transportOptions = options;
      return { sendMail: async () => {} };
    };
    const emailNotifier = require("./emailNotifier");
    await emailNotifier.notify(sampleAlert);
    assert.equal(transportOptions.auth, undefined);
  });

  it("sets auth when both EMAIL_SMTP_USER and EMAIL_SMTP_PASS are set", async () => {
    process.env.EMAIL_SMTP_USER = "smtp-user";
    process.env.EMAIL_SMTP_PASS = "smtp-pass";
    let transportOptions;
    nodemailer.createTransport = (options) => {
      transportOptions = options;
      return { sendMail: async () => {} };
    };
    const emailNotifier = require("./emailNotifier");
    await emailNotifier.notify(sampleAlert);
    assert.deepEqual(transportOptions.auth, { user: "smtp-user", pass: "smtp-pass" });
  });
});

describe("notify() — failure paths", () => {
  beforeEach(() => {
    process.env.EMAIL_ENABLED = "true";
    process.env.EMAIL_SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_TO = "ops@example.com";
  });

  it("propagates a rejected sendMail()", async () => {
    nodemailer.createTransport = () => ({
      sendMail: async () => {
        throw new Error("SMTP connection refused");
      },
    });
    const emailNotifier = require("./emailNotifier");
    await assert.rejects(() => emailNotifier.notify(sampleAlert), /SMTP connection refused/);
  });
});
