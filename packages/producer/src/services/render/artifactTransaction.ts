import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type ArtifactKind = "file" | "directory";

function siblingTransactionPath(destination: string, label: "staging" | "backup"): string {
  const parent = dirname(destination);
  const extension = extname(destination);
  const stem = extension ? basename(destination, extension) : basename(destination);
  return join(parent, `.${stem}.hf-${label}-${randomUUID()}${extension}`);
}

function assertReadableNonEmptyFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Render artifact is not a non-empty file: ${path}`);
  }
  const fd = openSync(path, "r");
  try {
    readSync(fd, Buffer.allocUnsafe(1), 0, 1, 0);
  } finally {
    closeSync(fd);
  }
}

function collectDirectoryFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

/**
 * Stages a render beside its final destination and promotes only a validated
 * artifact. Existing output is never opened or truncated by render stages.
 */
export class ArtifactTransaction {
  readonly destinationPath: string;
  readonly stagingPath: string;
  private readonly backupPath: string;
  private state: "active" | "committed" | "rolled-back" = "active";

  constructor(
    destinationPath: string,
    private readonly kind: ArtifactKind,
  ) {
    this.destinationPath = resolve(destinationPath);
    this.stagingPath = siblingTransactionPath(this.destinationPath, "staging");
    this.backupPath = siblingTransactionPath(this.destinationPath, "backup");
  }

  validate(): void {
    if (this.kind === "file") {
      assertReadableNonEmptyFile(this.stagingPath);
      return;
    }
    const stat = lstatSync(this.stagingPath);
    if (!stat.isDirectory()) {
      throw new Error(`Render artifact is not a directory: ${this.stagingPath}`);
    }
    const files = collectDirectoryFiles(this.stagingPath);
    if (files.length === 0) {
      throw new Error(`Render artifact directory is empty: ${this.stagingPath}`);
    }
    for (const file of files) assertReadableNonEmptyFile(file);
  }

  commit(): void {
    if (this.state !== "active") {
      throw new Error(`Cannot commit an artifact transaction in state ${this.state}`);
    }
    this.validate();
    const hadDestination = existsSync(this.destinationPath);
    if (hadDestination) renameSync(this.destinationPath, this.backupPath);
    try {
      renameSync(this.stagingPath, this.destinationPath);
      this.state = "committed";
    } catch (error) {
      if (hadDestination && existsSync(this.backupPath)) {
        if (existsSync(this.destinationPath)) {
          rmSync(this.destinationPath, { recursive: true, force: true });
        }
        renameSync(this.backupPath, this.destinationPath);
      }
      throw error;
    }
    if (hadDestination) {
      try {
        rmSync(this.backupPath, { recursive: true, force: true });
      } catch {
        // Promotion succeeded. A hidden stale backup is safer than reporting a
        // failed render after the caller-visible artifact was committed.
      }
    }
  }

  rollback(): void {
    if (this.state !== "active") return;
    rmSync(this.stagingPath, { recursive: true, force: true });
    if (existsSync(this.backupPath) && !existsSync(this.destinationPath)) {
      renameSync(this.backupPath, this.destinationPath);
    }
    this.state = "rolled-back";
  }
}
