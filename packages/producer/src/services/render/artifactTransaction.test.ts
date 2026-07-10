import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactTransaction } from "./artifactTransaction.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hf-artifact-transaction-"));
}

describe("ArtifactTransaction", () => {
  it("atomically replaces a file only after validation", () => {
    const dir = tempDir();
    const destination = join(dir, "render.mp4");
    writeFileSync(destination, "existing");
    const transaction = new ArtifactTransaction(destination, "file");
    writeFileSync(transaction.stagingPath, "new-render");

    transaction.commit();

    expect(readFileSync(destination, "utf8")).toBe("new-render");
    expect(existsSync(transaction.stagingPath)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.includes("hf-backup"))).toEqual([]);
  });

  it("leaves an existing file byte-identical when validation fails", () => {
    const dir = tempDir();
    const destination = join(dir, "render.gif");
    const existing = Buffer.from([0, 1, 2, 3, 255]);
    writeFileSync(destination, existing);
    const transaction = new ArtifactTransaction(destination, "file");
    writeFileSync(transaction.stagingPath, "");

    expect(() => transaction.commit()).toThrow("not a non-empty file");
    transaction.rollback();

    expect(readFileSync(destination)).toEqual(existing);
    expect(existsSync(transaction.stagingPath)).toBe(false);
  });

  it("removes cancelled staging output without touching the destination", () => {
    const dir = tempDir();
    const destination = join(dir, "render.mp4");
    writeFileSync(destination, "keep-me");
    const transaction = new ArtifactTransaction(destination, "file");
    writeFileSync(transaction.stagingPath, "partial-render");

    transaction.rollback();

    expect(readFileSync(destination, "utf8")).toBe("keep-me");
    expect(existsSync(transaction.stagingPath)).toBe(false);
  });

  it("promotes a validated PNG sequence as one directory artifact", () => {
    const dir = tempDir();
    const destination = join(dir, "frames");
    mkdirSync(destination);
    writeFileSync(join(destination, "frame_000001.png"), "old");
    const transaction = new ArtifactTransaction(destination, "directory");
    mkdirSync(transaction.stagingPath);
    writeFileSync(join(transaction.stagingPath, "frame_000001.png"), "png-1");
    writeFileSync(join(transaction.stagingPath, "frame_000002.png"), "png-2");

    transaction.commit();

    expect(readdirSync(destination).sort()).toEqual(["frame_000001.png", "frame_000002.png"]);
    expect(readFileSync(join(destination, "frame_000001.png"), "utf8")).toBe("png-1");
  });

  it("rejects an empty PNG sequence and preserves the existing directory", () => {
    const dir = tempDir();
    const destination = join(dir, "frames");
    mkdirSync(destination);
    writeFileSync(join(destination, "frame_000001.png"), "existing-frame");
    const transaction = new ArtifactTransaction(destination, "directory");
    mkdirSync(transaction.stagingPath);

    expect(() => transaction.commit()).toThrow("directory is empty");
    transaction.rollback();

    expect(readFileSync(join(destination, "frame_000001.png"), "utf8")).toBe("existing-frame");
  });
});
