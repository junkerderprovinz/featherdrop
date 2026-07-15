import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPrefs, savePrefs, PREFS_STORAGE_KEY } from "../lib/prefs";

// Minimal Storage stand-in (node has no localStorage).
function fakeStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

test("round-trips the remembered options", () => {
  const store = fakeStore();
  savePrefs({ expiry: "1d", maxDownloads: 3, stripMetadata: false }, store);
  assert.deepEqual(loadPrefs(store), {
    expiry: "1d",
    maxDownloads: 3,
    stripMetadata: false,
  });
});

test("missing/corrupt storage falls back to empty prefs", () => {
  assert.deepEqual(loadPrefs(null), {
    expiry: null,
    maxDownloads: null,
    stripMetadata: null,
  });
  const corrupt = fakeStore({ [PREFS_STORAGE_KEY]: "{not json" });
  assert.deepEqual(loadPrefs(corrupt), {
    expiry: null,
    maxDownloads: null,
    stripMetadata: null,
  });
});

test("invalid stored values are dropped field-by-field", () => {
  const store = fakeStore({
    [PREFS_STORAGE_KEY]: JSON.stringify({
      expiry: "13d", // not a valid option
      maxDownloads: -5, // below 1
      stripMetadata: "yes", // not a boolean
    }),
  });
  assert.deepEqual(loadPrefs(store), {
    expiry: null,
    maxDownloads: null,
    stripMetadata: null,
  });
});

test("fractional download limits are floored", () => {
  const store = fakeStore({
    [PREFS_STORAGE_KEY]: JSON.stringify({ expiry: "7d", maxDownloads: 2.9 }),
  });
  assert.equal(loadPrefs(store).maxDownloads, 2);
});

test("a throwing store never breaks load or save", () => {
  const boom = {
    getItem: () => {
      throw new Error("privacy mode");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };
  assert.deepEqual(loadPrefs(boom), {
    expiry: null,
    maxDownloads: null,
    stripMetadata: null,
  });
  assert.doesNotThrow(() =>
    savePrefs({ expiry: "1h", maxDownloads: null, stripMetadata: true }, boom),
  );
});
