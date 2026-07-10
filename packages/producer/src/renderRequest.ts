import { resolveConfig, type EngineConfig, type VideoFrameFormat } from "@hyperframes/engine";
import type { CanvasResolution, Fps } from "@hyperframes/core";
import type { ProducerLogger } from "./logger.js";
import type { RenderConfig } from "./services/renderOrchestrator.js";
import type { DistributedRenderConfig } from "./services/distributed/plan.js";
import type { SerializableDistributedRenderConfig } from "./services/distributed/renderConfigValidation.js";

export const RENDER_REQUEST_VERSION = 1 as const;

export interface DistributedRenderOptions {
  width: number;
  height: number;
  codec?: "h264" | "h265";
  chunkSize?: number;
  maxParallelChunks?: number;
  targetChunkFrames?: number;
  runtimeCap?: DistributedRenderConfig["runtimeCap"];
  rejectOnSystemFonts?: boolean;
  failClosedFontFetch?: boolean;
  cfr?: boolean;
  planDirSizeLimitBytes?: number;
}

/** JSON-safe render intent shared by local, Docker, server and cloud adapters. */
export interface RenderRequestOptions {
  fps: Fps;
  quality: "draft" | "standard" | "high";
  format: NonNullable<RenderConfig["format"]>;
  gifLoop?: number;
  workers?: number;
  useGpu?: boolean;
  debug?: boolean;
  strictness?: RenderConfig["strictness"];
  entryFile?: string;
  crf?: number;
  videoBitrate?: string;
  videoFrameFormat?: VideoFrameFormat;
  hdrMode?: RenderConfig["hdrMode"];
  variables?: Record<string, unknown>;
  outputResolution?: CanvasResolution;
  engineConfig: EngineConfig;
  distributed?: DistributedRenderOptions;
}

export interface RenderRequest {
  version: typeof RENDER_REQUEST_VERSION;
  projectDir: string;
  outputPath: string;
  options: RenderRequestOptions;
}

export interface CreateRenderRequestInput {
  projectDir: string;
  outputPath: string;
  options: Omit<RenderRequestOptions, "engineConfig">;
  engineConfig?: EngineConfig;
  engineOverrides?: Partial<EngineConfig>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPositiveFps(options: Record<string, unknown>): void {
  const fps = options.fps;
  if (
    !isPlainObject(fps) ||
    !Number.isInteger(fps.num) ||
    !Number.isInteger(fps.den) ||
    (fps.num as number) <= 0 ||
    (fps.den as number) <= 0
  ) {
    throw new Error("Render request fps must be a positive rational");
  }
}

function assertRequestOptions(options: unknown): asserts options is RenderRequestOptions {
  if (!isPlainObject(options)) throw new Error("Render request options must be an object");
  assertPositiveFps(options);
  if (!["draft", "standard", "high"].includes(String(options.quality))) {
    throw new Error("Render request quality is invalid");
  }
  if (!["mp4", "webm", "mov", "png-sequence", "gif"].includes(String(options.format))) {
    throw new Error("Render request format is invalid");
  }
  if (!isPlainObject(options.engineConfig)) {
    throw new Error("Render request must contain a resolved engineConfig snapshot");
  }
  if (options.variables !== undefined && !isPlainObject(options.variables)) {
    throw new Error("Render request variables must be a JSON object");
  }
}

function assertNonEmptyPath(value: unknown, field: "projectDir" | "outputPath"): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Render request ${field} must be a non-empty string`);
  }
}

function assertRenderRequest(value: unknown): asserts value is RenderRequest {
  if (!isPlainObject(value) || value.version !== RENDER_REQUEST_VERSION) {
    const version = isPlainObject(value) ? value.version : undefined;
    throw new Error(`Unsupported render request version: ${String(version)}`);
  }
  assertNonEmptyPath(value.projectDir, "projectDir");
  assertNonEmptyPath(value.outputPath, "outputPath");
  assertRequestOptions(value.options);
}

export function parseRenderRequest(serialized: string | unknown): RenderRequest {
  const value = typeof serialized === "string" ? JSON.parse(serialized) : serialized;
  assertRenderRequest(value);
  return value;
}

export function serializeRenderRequest(request: RenderRequest): string {
  assertRenderRequest(request);
  return JSON.stringify(request);
}

export function createRenderRequest(input: CreateRenderRequestInput): RenderRequest {
  const request = {
    version: RENDER_REQUEST_VERSION,
    projectDir: input.projectDir,
    outputPath: input.outputPath,
    options: {
      ...input.options,
      engineConfig: input.engineConfig ?? resolveConfig(input.engineOverrides),
    },
  } satisfies RenderRequest;
  // A JSON round-trip both proves serializability and detaches caller-owned
  // variables/config objects before asynchronous adapters receive them.
  return parseRenderRequest(JSON.stringify(request));
}

export function renderConfigFromRequest(
  request: RenderRequest,
  runtime: { logger?: ProducerLogger } = {},
): RenderConfig {
  const { engineConfig, distributed: _distributed, ...options } = request.options;
  return {
    ...options,
    producerConfig: engineConfig,
    logger: runtime.logger,
  };
}

function distributedFps(fps: Fps): 24 | 30 | 60 {
  if (fps.den === 1 && (fps.num === 24 || fps.num === 30 || fps.num === 60)) return fps.num;
  throw new Error(`Distributed render does not support fps ${fps.num}/${fps.den}`);
}

export function distributedConfigFromRequest(
  request: RenderRequest,
  runtime: { logger?: ProducerLogger; abortSignal?: AbortSignal } = {},
): DistributedRenderConfig {
  const options = request.options;
  const distributed = options.distributed;
  if (!distributed) throw new Error("Render request is missing distributed options");
  if (options.format === "gif") throw new Error("Distributed render does not support gif");
  if (options.hdrMode === "force-hdr") {
    throw new Error("Distributed render does not support force-hdr");
  }
  return {
    fps: distributedFps(options.fps),
    width: distributed.width,
    height: distributed.height,
    format: options.format,
    codec: distributed.codec,
    quality: options.quality,
    crf: options.crf,
    bitrate: options.videoBitrate,
    videoFrameFormat: options.videoFrameFormat,
    outputResolution: options.outputResolution,
    chunkSize: distributed.chunkSize,
    maxParallelChunks: distributed.maxParallelChunks,
    targetChunkFrames: distributed.targetChunkFrames,
    runtimeCap: distributed.runtimeCap,
    rejectOnSystemFonts: distributed.rejectOnSystemFonts,
    failClosedFontFetch: distributed.failClosedFontFetch,
    hdrMode: options.hdrMode === "auto" ? "auto" : "force-sdr",
    cfr: distributed.cfr,
    logger: runtime.logger,
    producerConfig: options.engineConfig,
    engineConfig: options.engineConfig,
    entryFile: options.entryFile,
    abortSignal: runtime.abortSignal,
    planDirSizeLimitBytes: distributed.planDirSizeLimitBytes,
    variables: options.variables,
  };
}

export function renderRequestFromDistributedConfig(input: {
  projectDir: string;
  outputPath: string;
  config: SerializableDistributedRenderConfig;
}): RenderRequest {
  const { config } = input;
  return createRenderRequest({
    projectDir: input.projectDir,
    outputPath: input.outputPath,
    engineConfig: config.engineConfig ?? resolveConfig(),
    options: {
      fps: { num: config.fps, den: 1 },
      quality: config.quality ?? "standard",
      format: config.format,
      crf: config.crf,
      videoBitrate: config.bitrate,
      videoFrameFormat: config.videoFrameFormat,
      outputResolution: config.outputResolution,
      hdrMode: config.hdrMode ?? "force-sdr",
      entryFile: config.entryFile,
      variables: config.variables,
      distributed: {
        width: config.width,
        height: config.height,
        codec: config.codec,
        chunkSize: config.chunkSize,
        maxParallelChunks: config.maxParallelChunks,
        targetChunkFrames: config.targetChunkFrames,
        runtimeCap: config.runtimeCap,
        rejectOnSystemFonts: config.rejectOnSystemFonts,
        failClosedFontFetch: config.failClosedFontFetch,
        cfr: config.cfr,
        planDirSizeLimitBytes: config.planDirSizeLimitBytes,
      },
    },
  });
}
