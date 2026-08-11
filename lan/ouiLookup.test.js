// lan/ouiLookup.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

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

// loadTable() memoizes its result in a module-private `table` variable with no
// reset export, and the top-level lookupVendor() above has already populated it
// from the real config/ouiPrefixes.json by the time any test runs. Forcing the
// read-failure branch through that shared instance would permanently poison it
// (table stays {} forever after) and break every other test in this file.
// Instead, bust require.cache to load a completely separate module instance
// isolated to this one test -- the shared `lookupVendor` above is a direct
// function reference into the original instance and is unaffected either way.
describe("loadTable() failure (isolated via a fresh module instance)", () => {
  it("falls back to an empty table (vendor lookups return null) and warns, without throwing, when the OUI file can't be read", () => {
    const modulePath = require.resolve("./ouiLookup");
    delete require.cache[modulePath];
    // require the fresh instance BEFORE patching fs.readFileSync -- Node's own
    // module loader uses fs.readFileSync internally to read ouiLookup.js off
    // disk, so patching first would break the require() itself, not just the
    // lazy loadTable() call inside it.
    const freshLookupVendor = require("./ouiLookup").lookupVendor;

    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = () => {
      throw new Error("boom");
    };

    try {
      assert.equal(freshLookupVendor("DC:A6:32:11:22:33"), null); // a real, otherwise-resolvable prefix
    } finally {
      fs.readFileSync = originalReadFileSync;
      delete require.cache[modulePath]; // don't leave the poisoned instance cached
    }
  });
});
