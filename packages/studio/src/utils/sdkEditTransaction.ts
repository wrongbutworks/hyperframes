import type { MutableRefObject } from "react";
import { openComposition, type Composition } from "@hyperframes/sdk";
import type { EditHistoryKind } from "./editHistory";
import { hashContent, markSelfWrite } from "../hooks/sdkSelfWriteRegistry";
import { trackStudioEvent } from "./studioTelemetry";

export type CutoverResult =
  | { status: "declined"; reason: string }
  | { status: "committed"; version: string }
  | { status: "failed"; error: Error };

export interface CutoverDeps {
  editHistory: {
    recordEdit: (entry: {
      label: string;
      kind: EditHistoryKind;
      coalesceKey?: string;
      files: Record<string, { before: string; after: string }>;
    }) => Promise<void>;
  };
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  reloadPreview: () => void;
  domEditSaveTimestampRef: MutableRefObject<number>;
  refresh?: (after: string) => void;
  compositionPath?: string | null;
  serialize?: <T>(key: string, task: () => Promise<T>) => Promise<T>;
  readProjectFile?: (path: string) => Promise<string>;
  /** Takes ownership of a fully persisted candidate session. */
  publishSession?: (session: Composition) => void;
  /** Test seam; production clones with openComposition. */
  createCandidateSession?: (serialized: string, live: Composition) => Promise<Composition>;
}

export interface CutoverOptions {
  label?: string;
  coalesceKey?: string;
  skipRefresh?: boolean;
}

interface CandidateEdit {
  live: Composition;
  candidate: Composition;
  serializedBefore: string;
  after: string;
}

// Candidate edits are read-modify-write transactions. Keep one queue per writer
// and path so overlapping edits from different Studio hooks cannot both clone a
// stale live session and let the later write erase the earlier one.
const mutationQueues = new WeakMap<
  CutoverDeps["writeProjectFile"],
  Map<string, Promise<unknown>>
>();

function serializeCandidateMutation<T>(
  writer: CutoverDeps["writeProjectFile"],
  targetPath: string,
  task: () => Promise<T>,
): Promise<T> {
  let queues = mutationQueues.get(writer);
  if (!queues) {
    queues = new Map();
    mutationQueues.set(writer, queues);
  }
  const prior = queues.get(targetPath) ?? Promise.resolve();
  const next = prior.then(task, task);
  queues.set(targetPath, next);
  void next.then(
    () => {
      if (queues?.get(targetPath) === next) queues.delete(targetPath);
    },
    () => {
      if (queues?.get(targetPath) === next) queues.delete(targetPath);
    },
  );
  return next;
}

export function declinedCutover(reason: string): CutoverResult {
  return { status: "declined", reason };
}

export function asCutoverError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Only an explicit decline may enter the legacy mutation backend. */
export function cutoverCommittedOrThrow(result: CutoverResult): boolean {
  if (result.status === "failed") throw result.error;
  return result.status === "committed";
}

export async function captureOnDiskBefore(
  deps: CutoverDeps,
  targetPath: string,
  serializedFallback: string,
): Promise<string> {
  if (!deps.readProjectFile) return serializedFallback;
  try {
    return await deps.readProjectFile(targetPath);
  } catch {
    return serializedFallback;
  }
}

function disposeCandidate(candidate: Composition | undefined, live: Composition): void {
  if (candidate && candidate !== live) candidate.dispose();
}

function createCandidateSession(
  serializedBefore: string,
  live: Composition,
  deps: CutoverDeps,
): Promise<Composition> {
  return deps.createCandidateSession
    ? deps.createCandidateSession(serializedBefore, live)
    : openComposition(serializedBefore, { history: false });
}

function candidatePublisherAvailable(
  candidate: Composition,
  live: Composition,
  deps: CutoverDeps,
): boolean {
  return candidate === live || deps.publishSession !== undefined;
}

async function buildCandidateEdit(
  live: Composition,
  deps: CutoverDeps,
  mutate: (candidate: Composition) => void,
  sourceSnapshot?: string,
): Promise<CandidateEdit | CutoverResult> {
  let candidate: Composition | undefined;
  try {
    const serializedBefore = sourceSnapshot ?? live.serialize();
    candidate = await createCandidateSession(serializedBefore, live, deps);
    candidate.batch(() => mutate(candidate!));
    const after = candidate.serialize();
    if (after === serializedBefore) {
      disposeCandidate(candidate, live);
      return declinedCutover("no_change");
    }
    if (!candidatePublisherAvailable(candidate, live, deps)) {
      disposeCandidate(candidate, live);
      return { status: "failed", error: new Error("SDK candidate publisher is unavailable") };
    }
    return { live, candidate, serializedBefore, after };
  } catch (error) {
    disposeCandidate(candidate, live);
    return { status: "failed", error: asCutoverError(error) };
  }
}

function isCutoverResult(value: CandidateEdit | CutoverResult): value is CutoverResult {
  return "status" in value;
}

async function rollbackWrite(
  targetPath: string,
  originalContent: string,
  expectedCurrentContent: string,
  deps: CutoverDeps,
  cause: Error,
): Promise<Error> {
  try {
    deps.domEditSaveTimestampRef.current = Date.now();
    markSelfWrite(targetPath, originalContent);
    await deps.writeProjectFile(targetPath, originalContent, expectedCurrentContent);
    return cause;
  } catch (rollbackError) {
    return new AggregateError(
      [cause, asCutoverError(rollbackError)],
      `SDK edit failed and rollback could not restore ${targetPath}`,
    );
  }
}

async function writeAndRecord(
  after: string,
  targetPath: string,
  originalContent: string,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<Error | null> {
  deps.domEditSaveTimestampRef.current = Date.now();
  markSelfWrite(targetPath, after);
  try {
    await deps.writeProjectFile(targetPath, after, originalContent);
  } catch (error) {
    return asCutoverError(error);
  }
  try {
    await deps.editHistory.recordEdit({
      label: options?.label ?? "Edit layer",
      kind: "manual",
      ...(options?.coalesceKey ? { coalesceKey: options.coalesceKey } : {}),
      files: { [targetPath]: { before: originalContent, after } },
    });
    return null;
  } catch (error) {
    return rollbackWrite(targetPath, originalContent, after, deps, asCutoverError(error));
  }
}

function refreshCommittedEdit(after: string, deps: CutoverDeps, options?: CutoverOptions): void {
  try {
    if (deps.refresh) deps.refresh(after);
    else if (!options?.skipRefresh) deps.reloadPreview();
  } catch (error) {
    trackStudioEvent("sdk_cutover_refresh_failed", { error: asCutoverError(error).message });
  }
}

async function commitCandidateEdit(
  edit: CandidateEdit,
  targetPath: string,
  originalContent: string,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<CutoverResult> {
  const writeError = await writeAndRecord(edit.after, targetPath, originalContent, deps, options);
  if (writeError) {
    if (edit.candidate !== edit.live) edit.candidate.dispose();
    return { status: "failed", error: writeError };
  }
  try {
    if (edit.candidate !== edit.live) deps.publishSession!(edit.candidate);
  } catch (error) {
    // Persistence and history are already committed. A publisher can throw
    // after installing the candidate, so rolling back disk or disposing the
    // candidate here can make all three authorities disagree (or dispose the
    // now-live session). Production publishers are non-throwing; keep the
    // durable commit authoritative and surface this post-commit fault.
    trackStudioEvent("sdk_cutover_publish_failed", {
      path: targetPath,
      error: asCutoverError(error).message,
    });
  }
  refreshCommittedEdit(edit.after, deps, options);
  return { status: "committed", version: hashContent(edit.after) };
}

export async function persistSdkCandidateMutation(
  live: Composition,
  targetPath: string,
  originalContent: string,
  deps: CutoverDeps,
  mutate: (candidate: Composition) => void,
  options?: CutoverOptions,
  sourceSnapshot?: string,
): Promise<CutoverResult> {
  const run = () =>
    serializeCandidateMutation(deps.writeProjectFile, targetPath, async () => {
      // Re-read only after acquiring the path queue. This makes each candidate
      // clone the latest committed bytes, even when React has not yet re-rendered
      // and the caller still holds the preceding live-session object.
      const serializedFallback = sourceSnapshot ?? originalContent;
      const onDiskBefore = await captureOnDiskBefore(deps, targetPath, serializedFallback);
      // Preserve the live-session path for adapters without a reader (notably
      // isolated consumers/tests). Production Studio supplies a reader so
      // queued edits always clone the latest durable source.
      const candidateSource = deps.readProjectFile ? onDiskBefore : sourceSnapshot;
      const candidate = await buildCandidateEdit(live, deps, mutate, candidateSource);
      if (isCutoverResult(candidate)) return candidate;
      return commitCandidateEdit(candidate, targetPath, onDiskBefore, deps, options);
    });
  // GSAP supplies a serializer shared with its legacy server mutation path.
  // Take that outer lock first, then the SDK-wide lock above, so SDK and legacy
  // writes to the same file cannot interleave without recursively locking.
  return deps.serialize ? deps.serialize(`gsap-file:${targetPath}`, run) : run();
}

/** Transactional writer for non-SDK islands and throwaway composition sessions. */
export async function persistSdkSerialize(
  after: string,
  targetPath: string,
  originalContent: string,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<void> {
  const error = await writeAndRecord(after, targetPath, originalContent, deps, options);
  if (error) throw error;
  refreshCommittedEdit(after, deps, options);
}
