import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Detached preview servers (`hyperframes preview --detach`) hand off between two
 * processes: the launching CLI spawns a detached child, the child binds a port
 * and reports back through a state file under `.hyperframes/preview/`. The
 * `.hyperframes` directory is excluded from both the file watcher and the
 * project signature, so this bookkeeping never triggers client refreshes.
 */

export interface DetachedServerState {
  /** Nonce minted by the launching process — pairs a state file to its launch. */
  launchId: string;
  status: "started" | "already-running";
  port: number;
  url: string;
  /** Deep link to the view the browser should land on (board during planning). */
  boardUrl: string;
  /** Server process id; null when an existing server was reused. */
  pid: number | null;
  projectName: string;
  projectDir: string;
  startedAt: string;
}

export function previewStatePaths(projectDir: string): {
  dir: string;
  state: string;
  log: string;
} {
  const dir = join(projectDir, ".hyperframes", "preview");
  return { dir, state: join(dir, "server.json"), log: join(dir, "server.log") };
}

export function writeServerState(projectDir: string, state: DetachedServerState): void {
  const paths = previewStatePaths(projectDir);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

export function readServerState(projectDir: string): DetachedServerState | null {
  const paths = previewStatePaths(projectDir);
  if (!existsSync(paths.state)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.state, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const state = parsed as DetachedServerState;
    if (typeof state.launchId !== "string" || typeof state.port !== "number") return null;
    return state;
  } catch {
    return null;
  }
}

/** Remove the state file, but only if it still belongs to `launchId`. */
export function clearServerState(projectDir: string, launchId: string): void {
  const current = readServerState(projectDir);
  if (current?.launchId !== launchId) return;
  rmSync(previewStatePaths(projectDir).state, { force: true });
}

/**
 * Wait for the detached child to report readiness. Resolves null when the child
 * dies first or the timeout passes — callers surface the log file then.
 */
export async function waitForServerState(
  projectDir: string,
  launchId: string,
  opts: { timeoutMs?: number; childAlive: () => boolean },
): Promise<DetachedServerState | null> {
  const readMatching = (): DetachedServerState | null => {
    const state = readServerState(projectDir);
    return state?.launchId === launchId ? state : null;
  };
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    const state = readMatching();
    if (state) return state;
    // A child that reused an existing server writes its state and exits
    // immediately — re-read once after noticing the exit so that write is
    // never mistaken for a startup failure.
    if (!opts.childAlive()) return readMatching();
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Idle limit for detached servers; 0 disables. Default one hour. */
export function resolveIdleLimitMs(envValue: string | undefined): number {
  const parsed = envValue === undefined ? Number.NaN : Number.parseInt(envValue, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return 60 * 60 * 1000;
}

/**
 * Decide whether a detached server should shut itself down. Returns the
 * human-readable reason, or null to keep serving. An open Studio tab counts as
 * activity (the storyboard polls the signature endpoint), so "idle" really
 * means nobody — human or agent — is looking.
 */
export function detachedShutdownReason(opts: {
  ownerPid: number | null;
  ownerAlive: (pid: number) => boolean;
  idleMs: number;
  idleLimitMs: number;
}): string | null {
  if (opts.ownerPid !== null && !opts.ownerAlive(opts.ownerPid)) {
    return `owner process ${opts.ownerPid} exited`;
  }
  if (opts.idleLimitMs > 0 && opts.idleMs >= opts.idleLimitMs) {
    return `idle for ${Math.round(opts.idleMs / 60_000)} minutes`;
  }
  return null;
}
