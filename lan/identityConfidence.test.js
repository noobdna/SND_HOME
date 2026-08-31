// lan/identityConfidence.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { computeIdentityConfidence, MEDIUM_OBSERVED_MS, HIGH_OBSERVED_MS } = require("./identityConfidence");

const NOW = new Date("2026-09-01T00:00:00.000Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

// Known OUI prefix used elsewhere in this codebase's own tests
// (ouiLookup.test.js): DC:A6:32 -> "Raspberry Pi Foundation".
const KNOWN_VENDOR_MAC = "DC:A6:32:11:22:33";
const UNKNOWN_VENDOR_MAC = "00:00:00:11:22:33";

describe("computeIdentityConfidence", () => {
  it("returns high: terminalId-grouped, vendor resolves, observed >= 7 days", () => {
    const device = {
      mac: KNOWN_VENDOR_MAC,
      nickname: null,
      terminalId: "aa:bb:cc:dd:ee:ff",
      firstSeenAt: daysAgo(10),
    };
    assert.equal(computeIdentityConfidence(device, { now: NOW }), "high");
  });

  it("returns medium: reviewed (nickname only, no terminalId) and observed >= 1 day", () => {
    const device = {
      mac: UNKNOWN_VENDOR_MAC,
      nickname: "living room TV",
      terminalId: null,
      firstSeenAt: daysAgo(2),
    };
    assert.equal(computeIdentityConfidence(device, { now: NOW }), "medium");
  });

  it("returns medium (not high) when terminalId is set but vendor does not resolve, even at 7+ days", () => {
    const device = {
      mac: UNKNOWN_VENDOR_MAC,
      nickname: null,
      terminalId: "aa:bb:cc:dd:ee:ff",
      firstSeenAt: daysAgo(10),
    };
    assert.equal(computeIdentityConfidence(device, { now: NOW }), "medium");
  });

  it("returns medium (not high) when vendor resolves and terminalId is set but observed under 7 days", () => {
    const device = {
      mac: KNOWN_VENDOR_MAC,
      nickname: null,
      terminalId: "aa:bb:cc:dd:ee:ff",
      firstSeenAt: daysAgo(3),
    };
    assert.equal(computeIdentityConfidence(device, { now: NOW }), "medium");
  });

  it("returns low: reviewed but observed under 1 day (freshly labeled)", () => {
    const device = {
      mac: KNOWN_VENDOR_MAC,
      nickname: "new device",
      terminalId: null,
      firstSeenAt: daysAgo(0.1),
    };
    assert.equal(computeIdentityConfidence(device, { now: NOW }), "low");
  });

  it("returns low: insufficient judgment material -- never reviewed (no nickname, no terminalId)", () => {
    const device = {
      mac: KNOWN_VENDOR_MAC,
      nickname: null,
      terminalId: null,
      firstSeenAt: daysAgo(30),
    };
    assert.equal(computeIdentityConfidence(device, { now: NOW }), "low");
  });

  it("returns low: insufficient judgment material -- reviewed but firstSeenAt missing", () => {
    const device = { mac: KNOWN_VENDOR_MAC, nickname: "x", terminalId: null, firstSeenAt: null };
    assert.equal(computeIdentityConfidence(device, { now: NOW }), "low");
  });

  it("returns low: insufficient judgment material -- reviewed but firstSeenAt is not a parseable date", () => {
    const device = { mac: KNOWN_VENDOR_MAC, nickname: "x", terminalId: null, firstSeenAt: "not-a-date" };
    assert.equal(computeIdentityConfidence(device, { now: NOW }), "low");
  });

  it("returns low: firstSeenAt in the future (malformed/untrusted) even if reviewed", () => {
    const device = { mac: KNOWN_VENDOR_MAC, nickname: "x", terminalId: null, firstSeenAt: daysAgo(-5) };
    assert.equal(computeIdentityConfidence(device, { now: NOW }), "low");
  });

  it("does not throw on a completely empty device object", () => {
    assert.equal(computeIdentityConfidence({}, { now: NOW }), "low");
  });

  it("does not throw when called with no options (uses real current time)", () => {
    const device = { mac: KNOWN_VENDOR_MAC, nickname: "x", terminalId: null, firstSeenAt: new Date().toISOString() };
    assert.equal(computeIdentityConfidence(device), "low");
  });

  it("existing-data compatibility: a pre-Phase-52 device record (no identity_confidence field at all, exactly today's lanDevices.json schema) computes without error", () => {
    // Mirrors this deployment's real lanDevices.json entries exactly:
    // {mac, ip, vendor, nickname, terminalId, online, respondedToPing,
    //  inArpTable, firstSeenAt, lastSeenAt} -- no identity_confidence key.
    const legacyDevice = {
      mac: "74:24:9f:c9:c0:db",
      ip: "192.168.1.1",
      vendor: null,
      nickname: null,
      terminalId: null,
      online: true,
      respondedToPing: true,
      inArpTable: true,
      firstSeenAt: daysAgo(5),
      lastSeenAt: daysAgo(0),
    };
    assert.doesNotThrow(() => computeIdentityConfidence(legacyDevice, { now: NOW }));
    assert.equal(computeIdentityConfidence(legacyDevice, { now: NOW }), "low"); // never reviewed
  });

  it("thresholds are the documented 1 day / 7 days (guards against an accidental unit change)", () => {
    assert.equal(MEDIUM_OBSERVED_MS, 24 * 60 * 60 * 1000);
    assert.equal(HIGH_OBSERVED_MS, 7 * 24 * 60 * 60 * 1000);
  });
});
