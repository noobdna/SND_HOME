// lan/ouiLookup.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { lookupVendor } = require("./ouiLookup");

describe("lookupVendor", () => {
  it("resolves a known prefix (colon-separated, uppercase)", () => {
    assert.equal(lookupVendor("DC:A6:32:11:22:33"), "Raspberry Pi Foundation");
  });

  it("resolves a known prefix regardless of case", () => {
    assert.equal(lookupVendor("dc:a6:32:11:22:33"), "Raspberry Pi Foundation");
  });

  it("resolves a known prefix given hyphen separators", () => {
    assert.equal(lookupVendor("DC-A6-32-11-22-33"), "Raspberry Pi Foundation");
  });

  it("returns null for an unknown prefix", () => {
    assert.equal(lookupVendor("00:00:00:11:22:33"), null);
  });

  it("returns null for a malformed value", () => {
    assert.equal(lookupVendor("not-a-mac"), null);
    assert.equal(lookupVendor(""), null);
    assert.equal(lookupVendor(null), null);
    assert.equal(lookupVendor(undefined), null);
  });

  it("does not treat the _comment metadata key as a real OUI entry", () => {
    assert.equal(lookupVendor("_c:om:me:nt:00:00"), null);
  });
});
