import { describe, expect, it } from "vite-plus/test";

import { lifecycleVerdict, type LifecycleInput, type ShellThread } from "./lifecycle.ts";

const MINUTE = 60_000;
const settled: ShellThread = {
  settledAt: "2026-10-17T10:00:00.000Z",
  activeRunId: null,
  archivedAt: null,
  pendingBackgroundTasks: [],
};
const base: LifecycleInput = {
  threads: [settled],
  viewedAt: 0,
  activeAt: 0,
  savedAt: 0,
  now: 60 * MINUTE,
  sleepAfterMs: 10 * MINUTE,
  checkpointEveryMs: 30 * MINUTE,
};

describe("lifecycleVerdict", () => {
  it("sleeps a settled sandbox nobody has viewed for a while", () => {
    expect(lifecycleVerdict(base)).toBe("sleep");
  });

  it("keeps a settled sandbox awake while someone is viewing it", () => {
    expect(lifecycleVerdict({ ...base, viewedAt: base.now - MINUTE })).toBe("stay");
  });

  it("never sleeps a thread that is still working", () => {
    for (const thread of [
      { ...settled, settledAt: null },
      { ...settled, activeRunId: "run-1" },
      { ...settled, pendingBackgroundTasks: [{}] },
    ]) {
      expect(lifecycleVerdict({ ...base, threads: [thread], activeAt: 1 })).toBe("checkpoint");
    }
  });

  it("ignores archived threads", () => {
    const archived = { ...settled, settledAt: null, archivedAt: "2026-10-17T10:00:00.000Z" };
    expect(lifecycleVerdict({ ...base, threads: [archived] })).toBe("sleep");
  });

  it("sleeps a sandbox that never got a thread once nobody views it", () => {
    expect(lifecycleVerdict({ ...base, threads: [] })).toBe("sleep");
  });

  it("checkpoints an awake sandbox only when something happened since the last save", () => {
    const working = { ...base, threads: [{ ...settled, settledAt: null }] };
    expect(lifecycleVerdict({ ...working, activeAt: 10 * MINUTE, savedAt: 5 * MINUTE })).toBe(
      "checkpoint",
    );
    expect(lifecycleVerdict({ ...working, activeAt: 4 * MINUTE, savedAt: 5 * MINUTE })).toBe(
      "stay",
    );
    expect(lifecycleVerdict({ ...working, activeAt: 50 * MINUTE, savedAt: 40 * MINUTE })).toBe(
      "stay",
    );
  });
});
