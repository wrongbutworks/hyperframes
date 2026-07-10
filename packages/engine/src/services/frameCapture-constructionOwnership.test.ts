// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page, PuppeteerNode } from "puppeteer-core";
import {
  _resetBrowserPoolForTests,
  _setPuppeteerForTests,
  drainBrowserPool,
} from "./browserManager.js";
import { createCaptureSession } from "./frameCapture.js";

describe("createCaptureSession construction ownership", () => {
  afterEach(async () => {
    await drainBrowserPool();
    _resetBrowserPoolForTests();
    _setPuppeteerForTests(undefined);
  });

  it("closes the page and releases its exact browser lease when bootstrap fails", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "hf-session-owner-"));
    const page = {
      evaluateOnNewDocument: vi.fn().mockRejectedValue(new Error("bootstrap failed")),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
    const browser = {
      connected: true,
      newPage: vi.fn().mockResolvedValue(page),
      version: vi.fn().mockResolvedValue("HeadlessChrome/150.0.0.0"),
      close: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      process: () => null,
    } as unknown as Browser;
    _setPuppeteerForTests({
      launch: vi.fn().mockResolvedValue(browser),
    } as unknown as PuppeteerNode);

    try {
      await expect(
        createCaptureSession(
          "http://127.0.0.1:3000",
          outputDir,
          { width: 320, height: 180, fps: { num: 30, den: 1 }, format: "jpeg" },
          null,
          {
            browserGpuMode: "software",
            enableBrowserPool: true,
            forceScreenshot: true,
          },
        ),
      ).rejects.toThrow("bootstrap failed");

      expect(page.close).toHaveBeenCalledTimes(1);
      expect(browser.close).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
