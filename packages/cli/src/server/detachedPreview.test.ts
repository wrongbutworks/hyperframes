import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearServerState,
  detachedShutdownReason,
  previewStatePaths,
  readServerState,
  resolveIdleLimitMs,
  waitForServerState,
  writeServerState,
  type DetachedServerState,
} from "./detachedPreview.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "hf-detached-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeState(overrides: Partial<DetachedServerState> = {}): DetachedServerState {
  return {
    launchId: "launch-1",
    status: "started",
    port: 3002,
    url: "http://localhost:3002",
    boardUrl: "http://localhost:3002/?view=storyboard#project/demo",
    pid: 1234,
    projectName: "demo",
    projectDir: "/tmp/demo",
    startedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("server state file round-trip", () => {
  it("writes and reads back the state", () => {
    const dir = tempProject();
    writeServerState(dir, makeState());
    expect(readServerState(dir)).toMatchObject({ launchId: "launch-1", port: 3002 });
  });

  it("returns null for a missing or corrupt state file", () => {
    const dir = tempProject();
    expect(readServerState(dir)).toBeNull();
    const paths = previewStatePaths(dir);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.state, "not json");
    expect(readServerState(dir)).toBeNull();
  });

  it("clearServerState only removes its own launch's file", () => {
    const dir = tempProject();
    writeServerState(dir, makeState({ launchId: "newer-launch" }));
    clearServerState(dir, "old-launch");
    expect(readServerState(dir)).not.toBeNull();
    clearServerState(dir, "newer-launch");
    expect(readServerState(dir)).toBeNull();
  });
});

describe("waitForServerState", () => {
  it("resolves once the matching state lands", async () => {
    const dir = tempProject();
    setTimeout(() => writeServerState(dir, makeState()), 50);
    const state = await waitForServerState(dir, "launch-1", {
      timeoutMs: 2000,
      childAlive: () => true,
    });
    expect(state?.port).toBe(3002);
  });

  it("re-reads after a child exit so write-then-exit is not a failure", async () => {
    const dir = tempProject();
    writeServerState(dir, makeState({ status: "already-running", pid: null }));
    const state = await waitForServerState(dir, "launch-1", {
      timeoutMs: 2000,
      childAlive: () => false,
    });
    expect(state?.status).toBe("already-running");
  });

  it("fails fast when the child dies without reporting", async () => {
    const dir = tempProject();
    const state = await waitForServerState(dir, "launch-1", {
      timeoutMs: 2000,
      childAlive: () => false,
    });
    expect(state).toBeNull();
  });

  it("ignores a stale state file from a previous launch", async () => {
    const dir = tempProject();
    writeServerState(dir, makeState({ launchId: "previous-launch" }));
    const state = await waitForServerState(dir, "launch-2", {
      timeoutMs: 300,
      childAlive: () => true,
    });
    expect(state).toBeNull();
  });
});

describe("detachedShutdownReason", () => {
  const HOUR = 60 * 60 * 1000;

  it("keeps serving while active and owned", () => {
    expect(
      detachedShutdownReason({
        ownerPid: 42,
        ownerAlive: () => true,
        idleMs: 5 * 60 * 1000,
        idleLimitMs: HOUR,
      }),
    ).toBeNull();
  });

  it("shuts down when the owner is gone", () => {
    expect(
      detachedShutdownReason({
        ownerPid: 42,
        ownerAlive: () => false,
        idleMs: 0,
        idleLimitMs: HOUR,
      }),
    ).toContain("owner process 42");
  });

  it("shuts down past the idle limit, but never with the limit disabled", () => {
    const base = { ownerPid: null, ownerAlive: () => true };
    expect(detachedShutdownReason({ ...base, idleMs: HOUR, idleLimitMs: HOUR })).toContain("idle");
    expect(detachedShutdownReason({ ...base, idleMs: 10 * HOUR, idleLimitMs: 0 })).toBeNull();
  });
});

describe("resolveIdleLimitMs", () => {
  it("defaults to one hour and honors overrides including 0", () => {
    expect(resolveIdleLimitMs(undefined)).toBe(60 * 60 * 1000);
    expect(resolveIdleLimitMs("120000")).toBe(120000);
    expect(resolveIdleLimitMs("0")).toBe(0);
    expect(resolveIdleLimitMs("not-a-number")).toBe(60 * 60 * 1000);
  });
});
