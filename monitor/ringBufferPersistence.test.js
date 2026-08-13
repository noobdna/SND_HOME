// monitor/ringBufferPersistence.test.js
// monitor/historyStore.js 等4ストアが共有する writeEntries/readEntries/
// createAutoFlush の単体テスト。各ストア固有のテストは各 *.test.js が担うため、
// ここでは共通ヘルパー自体の挙動(ファイルI/O・グレースフルデグレード・
// タイマー配線)のみを検証する。
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { writeEntries, readEntries, createAutoFlush } = require("./ringBufferPersistence");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ringbuffer-persistence-test-"));
function tmpFile() {
  return path.join(tmpDir, `entries-${Math.random().toString(36).slice(2)}.json`);
}

describe("writeEntries / readEntries", () => {
  it("writes an array and reads it back identically", () => {
    const file = tmpFile();
    const entries = [{ a: 1 }, { a: 2 }];
    writeEntries(file, entries);
    assert.deepEqual(readEntries(file, "test"), entries);
  });

  it("creates the containing directory if needed", () => {
    const nested = path.join(tmpDir, "nested", "dir", "entries.json");
    writeEntries(nested, [{ a: 1 }]);
    assert.ok(fs.existsSync(nested));
  });

  it("readEntries() returns an empty array for a nonexistent file (not an error)", () => {
    assert.deepEqual(readEntries(tmpFile(), "test"), []);
  });

  it("readEntries() returns an empty array for malformed JSON without throwing", () => {
    const file = tmpFile();
    fs.writeFileSync(file, "{not valid json");
    assert.deepEqual(readEntries(file, "test"), []);
  });

  it("readEntries() returns an empty array when the JSON is not an array", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ not: "an array" }));
    assert.deepEqual(readEntries(file, "test"), []);
  });

  it("readEntries() returns an empty array when the file can't be read (e.g. permission error), without throwing", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify([{ a: 1 }]));

    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = (targetPath, ...rest) => {
      if (targetPath === file) {
        throw new Error("EACCES: permission denied");
      }
      return originalReadFileSync(targetPath, ...rest);
    };
    try {
      assert.deepEqual(readEntries(file, "test"), []);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  });
});

describe("createAutoFlush", () => {
  let originalSetInterval;
  let originalClearInterval;

  beforeEach(() => {
    originalSetInterval = global.setInterval;
    originalClearInterval = global.clearInterval;
  });

  afterEach(() => {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  });

  it("start() schedules flushFn on the given interval", () => {
    let scheduledFn;
    let scheduledMs;
    global.setInterval = (fn, ms) => {
      scheduledFn = fn;
      scheduledMs = ms;
      return { unref: () => {} };
    };

    let calls = 0;
    const autoFlush = createAutoFlush(() => calls++, 30_000);
    autoFlush.start();

    assert.equal(scheduledMs, 30_000);
    scheduledFn();
    assert.equal(calls, 1);
  });

  it("start() is idempotent -- calling it twice does not schedule a second timer", () => {
    let scheduleCount = 0;
    global.setInterval = () => {
      scheduleCount++;
      return { unref: () => {} };
    };

    const autoFlush = createAutoFlush(() => {}, 30_000);
    autoFlush.start();
    autoFlush.start();

    assert.equal(scheduleCount, 1);
  });

  it("stop() clears the timer, and start() can schedule a new one afterward", () => {
    let cleared = false;
    global.setInterval = () => ({ unref: () => {} });
    global.clearInterval = () => {
      cleared = true;
    };

    const autoFlush = createAutoFlush(() => {}, 30_000);
    autoFlush.start();
    autoFlush.stop();

    assert.equal(cleared, true);

    let scheduleCount = 0;
    global.setInterval = () => {
      scheduleCount++;
      return { unref: () => {} };
    };
    autoFlush.start();
    assert.equal(scheduleCount, 1);
  });

  it("calls timer.unref() if available, so the timer alone doesn't keep the process alive", () => {
    let unrefCalled = false;
    global.setInterval = () => ({ unref: () => (unrefCalled = true) });

    const autoFlush = createAutoFlush(() => {}, 30_000);
    autoFlush.start();

    assert.equal(unrefCalled, true);
  });
});
