/* eslint-disable @typescript-eslint/no-floating-promises */
// Talent → Matchmaker continuation record tests (M2 #87).
//
// Pins the bounded-recovery contract:
//   - round-trip
//   - missing key / corrupt JSON / shape mismatch → null
//   - corrupt / mismatched entries are cleared (terminal boundary)
//   - non-destructive read (record survives a read)
//   - expired record (createdAt older than TTL) → null + cleared
//   - setItem failure throws (so the /talent page can surface it
//     inline rather than silently losing the navigation context)
//   - storage unavailable (window undefined) → null

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY,
  TALENT_MATCHMAKER_CONTEXT_TTL_MS,
  type TalentMatchmakerContext,
  clearTalentMatchmakerContext,
  readTalentMatchmakerContext,
  setTalentMatchmakerContext,
} from "./talent-matchmaker-context.js";

const SAMPLE_VALUE: Omit<TalentMatchmakerContext, "createdAt"> = {
  source: "talent",
  offeringId: "of-1",
  query: "Haitian producer in New York for a remote dancehall single",
  filters: {
    primaryCategoryKey: "music-production",
    independentlyPurchasableServiceKey: "",
    serviceModes: ["Remote"],
    basedIn: { city: "", region: "", countryCode: "US" },
    serviceArea: { city: "", region: "", countryCode: "" },
  },
};

function installStorageMock(): {
  readonly store: Map<string, string>;
  readonly failOnSetItem: { current: boolean };
} {
  const store = new Map<string, string>();
  const failOnSetItem = { current: false };
  const mock = {
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    setItem(key: string, value: string): void {
      if (failOnSetItem.current) {
        throw new Error("QuotaExceededError (mock)");
      }
      store.set(key, value);
    },
    removeItem(key: string): void {
      store.delete(key);
    },
  };
  // The module reads `window.localStorage` lazily inside each call,
  // so installing the mock before the test starts is sufficient.
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: mock },
    configurable: true,
    writable: true,
  });
  return { store, failOnSetItem };
}

beforeEach(() => {
  installStorageMock();
});

afterEach(() => {
  clearTalentMatchmakerContext();
  // Detach the window mock so a following test that forgets to
  // install it sees the server-side-render fallback.
  delete (globalThis as { window?: unknown }).window;
});

describe("talent-matchmaker-context (M2 #87)", () => {
  test("round-trip: set then read returns the same record (with createdAt)", () => {
    setTalentMatchmakerContext(SAMPLE_VALUE);
    const read = readTalentMatchmakerContext();
    assert.ok(read, "read should return the record after a successful set");
    assert.equal(read.source, "talent");
    assert.equal(read.offeringId, SAMPLE_VALUE.offeringId);
    assert.equal(read.query, SAMPLE_VALUE.query);
    assert.deepEqual(read.filters, SAMPLE_VALUE.filters);
    // createdAt is set by setTalentMatchmakerContext using new Date(),
    // so it is a valid ISO timestamp string.
    assert.equal(typeof read.createdAt, "string");
    assert.ok(!Number.isNaN(Date.parse(read.createdAt)));
  });

  test("non-destructive read: a successful read does NOT clear the record", () => {
    setTalentMatchmakerContext(SAMPLE_VALUE);
    const first = readTalentMatchmakerContext();
    const second = readTalentMatchmakerContext();
    assert.ok(first, "first read should return the record");
    assert.ok(second, "second read should still return the record (non-destructive)");
    assert.equal(first.createdAt, second.createdAt);
  });

  test("missing key: read returns null", () => {
    assert.equal(readTalentMatchmakerContext(), null);
  });

  test("corrupt JSON: read returns null AND clears the bad entry", () => {
    const { store } = installStorageMock();
    store.set(TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY, "not-json");
    assert.equal(readTalentMatchmakerContext(), null);
    assert.equal(
      store.has(TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY),
      false,
      "corrupt entry must be cleared by a failed read",
    );
  });

  test("shape mismatch: extra field → null AND cleared", () => {
    const { store } = installStorageMock();
    const record = { ...SAMPLE_VALUE, createdAt: new Date().toISOString(), extra: "poison" };
    store.set(TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY, JSON.stringify(record));
    assert.equal(readTalentMatchmakerContext(), null);
    assert.equal(store.has(TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY), false);
  });

  test("shape mismatch: wrong source → null AND cleared", () => {
    const { store } = installStorageMock();
    const record = { ...SAMPLE_VALUE, source: "elsewhere", createdAt: new Date().toISOString() };
    store.set(TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY, JSON.stringify(record));
    assert.equal(readTalentMatchmakerContext(), null);
    assert.equal(store.has(TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY), false);
  });

  test("shape mismatch: invalid serviceMode → null AND cleared", () => {
    const { store } = installStorageMock();
    const record = {
      ...SAMPLE_VALUE,
      filters: { ...SAMPLE_VALUE.filters, serviceModes: ["Remote", "Teleportation"] },
      createdAt: new Date().toISOString(),
    };
    store.set(TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY, JSON.stringify(record));
    assert.equal(readTalentMatchmakerContext(), null);
    assert.equal(store.has(TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY), false);
  });

  test("expired record (older than 5 min): null AND cleared", () => {
    const createdAt = new Date(Date.parse("2026-01-01T00:00:00.000Z")).toISOString();
    const { store } = installStorageMock();
    const record = { ...SAMPLE_VALUE, createdAt };
    store.set(TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY, JSON.stringify(record));
    const nowMs = Date.parse(createdAt) + TALENT_MATCHMAKER_CONTEXT_TTL_MS + 1;
    const read = readTalentMatchmakerContext(() => nowMs);
    assert.equal(read, null, "record older than TTL must read as null");
    assert.equal(store.has(TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY), false);
  });

  test("boundary: record at exactly TTL ms is still valid", () => {
    const createdAt = new Date(Date.parse("2026-01-01T00:00:00.000Z")).toISOString();
    const { store } = installStorageMock();
    store.set(
      TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY,
      JSON.stringify({ ...SAMPLE_VALUE, createdAt }),
    );
    const nowMs = Date.parse(createdAt) + TALENT_MATCHMAKER_CONTEXT_TTL_MS;
    const read = readTalentMatchmakerContext(() => nowMs);
    assert.ok(read, "record at exactly TTL ms boundary must still be valid");
  });

  test("clear is a terminal boundary: subsequent read returns null", () => {
    setTalentMatchmakerContext(SAMPLE_VALUE);
    assert.ok(readTalentMatchmakerContext());
    clearTalentMatchmakerContext();
    assert.equal(readTalentMatchmakerContext(), null);
  });

  test("setItem failure throws so the caller can surface it inline", () => {
    const { failOnSetItem } = installStorageMock();
    failOnSetItem.current = true;
    assert.throws(() => setTalentMatchmakerContext(SAMPLE_VALUE));
  });

  test("newest set overwrites the prior record (no stacking)", () => {
    setTalentMatchmakerContext(SAMPLE_VALUE);
    const newer: Omit<TalentMatchmakerContext, "createdAt"> = {
      ...SAMPLE_VALUE,
      offeringId: "of-2",
    };
    setTalentMatchmakerContext(newer);
    const read = readTalentMatchmakerContext();
    assert.ok(read);
    assert.equal(read.offeringId, "of-2");
  });

  test("storage unavailable (window undefined): read returns null, set throws", () => {
    delete (globalThis as { window?: unknown }).window;
    assert.equal(readTalentMatchmakerContext(), null);
    assert.throws(() => setTalentMatchmakerContext(SAMPLE_VALUE));
  });
});
