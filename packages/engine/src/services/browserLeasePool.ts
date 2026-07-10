import type { Browser } from "puppeteer-core";

export type CaptureMode = "beginframe" | "screenshot" | "drawelement";
export type BrowserPoolState = "launching" | "ready" | "closing";

export interface BrowserLaunchFingerprint {
  readonly args: readonly string[];
  readonly executablePath?: string;
  readonly browserTimeoutMs: number;
  readonly protocolTimeoutMs: number;
  readonly requestedCaptureMode: CaptureMode;
}

export interface BrowserLaunchResult {
  browser: Browser;
  captureMode: CaptureMode;
}

export interface BrowserLease extends BrowserLaunchResult {
  readonly fingerprint: Readonly<BrowserLaunchFingerprint>;
  release(): Promise<void>;
  forceRelease(): void;
}

interface BrowserPoolEntry {
  readonly key: string;
  readonly fingerprint: Readonly<BrowserLaunchFingerprint>;
  readonly pooled: boolean;
  state: BrowserPoolState;
  refCount: number;
  closeRequested: boolean;
  result?: BrowserLaunchResult;
  launchPromise: Promise<BrowserLaunchResult>;
  closePromise?: Promise<void>;
}

export interface BrowserLeasePoolOptions {
  launch(fingerprint: Readonly<BrowserLaunchFingerprint>): Promise<BrowserLaunchResult>;
  close(browser: Browser): Promise<void>;
  forceClose(browser: Browser): void;
}

function freezeFingerprint(
  fingerprint: BrowserLaunchFingerprint,
): Readonly<BrowserLaunchFingerprint> {
  return Object.freeze({
    ...fingerprint,
    args: Object.freeze([...fingerprint.args]),
  });
}

function fingerprintKey(fingerprint: Readonly<BrowserLaunchFingerprint>): string {
  return JSON.stringify([
    fingerprint.args,
    fingerprint.executablePath ?? null,
    fingerprint.browserTimeoutMs,
    fingerprint.protocolTimeoutMs,
    fingerprint.requestedCaptureMode,
  ]);
}

/** Owns pooled browser generations and hands callers exactly-once leases. */
export class BrowserLeasePool {
  private readonly available = new Map<string, BrowserPoolEntry>();
  private readonly entries = new Set<BrowserPoolEntry>();
  private readonly leasesByBrowser = new Map<Browser, Set<BrowserLease>>();
  private drainPromise: Promise<void> | null = null;

  constructor(private readonly options: BrowserLeasePoolOptions) {}

  async acquire(
    fingerprintInput: BrowserLaunchFingerprint,
    pooled: boolean,
  ): Promise<BrowserLease> {
    if (this.drainPromise) await this.drainPromise;

    const fingerprint = freezeFingerprint(fingerprintInput);
    const entry = this.reserveEntry(fingerprint, pooled);
    return this.issueLease(entry);
  }

  private async issueLease(entry: BrowserPoolEntry): Promise<BrowserLease> {
    try {
      const result = await entry.launchPromise;
      if (entry.state !== "ready") {
        throw new Error("Browser pool drained during acquisition");
      }
      return this.createLease(entry, result);
    } catch (error) {
      entry.refCount = Math.max(0, entry.refCount - 1);
      throw error;
    }
  }

  private reserveEntry(
    fingerprint: Readonly<BrowserLaunchFingerprint>,
    pooled: boolean,
  ): BrowserPoolEntry {
    const key = fingerprintKey(fingerprint);
    let entry = pooled ? this.available.get(key) : undefined;
    if (entry?.state === "ready" && !entry.result?.browser.connected) {
      this.requestClose(entry, true);
      entry = undefined;
    }
    if (!entry || entry.state === "closing") return this.createEntry(key, fingerprint, pooled);
    entry.refCount += 1;
    return entry;
  }

  /** Close only a browser that is not owned by this pool's active leases. */
  async releaseUnleased(browser: Browser): Promise<boolean> {
    if (this.leasesByBrowser.has(browser)) return false;
    await this.options.close(browser).catch(() => {});
    return true;
  }

  /** Force-close only a browser that is not owned by an active lease. */
  forceReleaseUnleased(browser: Browser): boolean {
    if (this.leasesByBrowser.has(browser)) return false;
    this.options.forceClose(browser);
    return true;
  }

  drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    const entries = [...this.entries];
    for (const entry of entries) this.requestClose(entry, false);
    this.drainPromise = Promise.all(entries.map((entry) => entry.closePromise)).then(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  /** Test-only state reset. Call `drain()` first when entries own real browsers. */
  reset(): void {
    this.available.clear();
    this.entries.clear();
    this.leasesByBrowser.clear();
    this.drainPromise = null;
  }

  private createEntry(
    key: string,
    fingerprint: Readonly<BrowserLaunchFingerprint>,
    pooled: boolean,
  ): BrowserPoolEntry {
    const entry: BrowserPoolEntry = {
      key,
      fingerprint,
      pooled,
      state: "launching",
      refCount: 1,
      closeRequested: false,
      launchPromise: undefined as unknown as Promise<BrowserLaunchResult>,
    };
    entry.launchPromise = this.options.launch(fingerprint).then(
      (result) => {
        entry.result = result;
        if (entry.closeRequested) {
          entry.state = "closing";
        } else {
          entry.state = "ready";
        }
        return result;
      },
      (error: unknown) => {
        if (this.available.get(key) === entry) this.available.delete(key);
        this.entries.delete(entry);
        throw error;
      },
    );
    this.entries.add(entry);
    if (pooled) this.available.set(key, entry);
    return entry;
  }

  private createLease(entry: BrowserPoolEntry, result: BrowserLaunchResult): BrowserLease {
    let active = true;
    let lease: BrowserLease;
    const deactivate = (force: boolean): boolean => {
      if (!active) return false;
      active = false;
      this.removeLease(result.browser, lease);
      entry.refCount = Math.max(0, entry.refCount - 1);
      if (entry.refCount === 0) this.requestClose(entry, force);
      return true;
    };
    lease = {
      ...result,
      fingerprint: entry.fingerprint,
      release: async () => {
        if (!deactivate(false)) return;
        await entry.closePromise;
      },
      forceRelease: () => {
        deactivate(true);
      },
    };
    const leases = this.leasesByBrowser.get(result.browser) ?? new Set<BrowserLease>();
    leases.add(lease);
    this.leasesByBrowser.set(result.browser, leases);
    return lease;
  }

  private requestClose(entry: BrowserPoolEntry, force: boolean): void {
    if (entry.closePromise) return;
    entry.closeRequested = true;
    if (this.available.get(entry.key) === entry) this.available.delete(entry.key);
    entry.closePromise = entry.launchPromise
      .then(async (result) => {
        entry.state = "closing";
        if (force) {
          this.options.forceClose(result.browser);
        } else {
          await this.options.close(result.browser).catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => {
        this.entries.delete(entry);
        if (entry.result) this.leasesByBrowser.delete(entry.result.browser);
      });
  }

  private removeLease(browser: Browser, lease: BrowserLease): void {
    const leases = this.leasesByBrowser.get(browser);
    if (!leases) return;
    leases.delete(lease);
    if (leases.size === 0) this.leasesByBrowser.delete(browser);
  }
}
