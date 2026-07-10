import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@hyperframes/engine";
import {
  createRenderRequest,
  distributedConfigFromRequest,
  parseRenderRequest,
  renderConfigFromRequest,
  renderRequestFromDistributedConfig,
  serializeRenderRequest,
} from "./renderRequest.js";

const originalForceScreenshot = process.env.PRODUCER_FORCE_SCREENSHOT;

afterEach(() => {
  if (originalForceScreenshot === undefined) delete process.env.PRODUCER_FORCE_SCREENSHOT;
  else process.env.PRODUCER_FORCE_SCREENSHOT = originalForceScreenshot;
});

function request() {
  return createRenderRequest({
    projectDir: "/project",
    outputPath: "/output/video.mp4",
    engineConfig: { ...DEFAULT_CONFIG, protocolTimeout: 123_456 },
    options: {
      fps: { num: 30, den: 1 },
      quality: "high",
      format: "mp4",
      workers: 3,
      useGpu: true,
      strictness: "best-effort",
      entryFile: "compositions/main.html",
      crf: 18,
      videoFrameFormat: "png",
      hdrMode: "force-sdr",
      variables: { title: "Hello", nested: { count: 2 } },
      outputResolution: "landscape-4k",
      distributed: {
        width: 1920,
        height: 1080,
        codec: "h264",
        chunkSize: 120,
        maxParallelChunks: 8,
        cfr: true,
      },
    },
  });
}

describe("RenderRequest", () => {
  it("round-trips through JSON without dropping nested options", () => {
    const value = request();
    expect(parseRenderRequest(serializeRenderRequest(value))).toEqual(value);
  });

  it("adapts the same request to local and distributed execution", () => {
    const value = request();
    const local = renderConfigFromRequest(value);
    const distributed = distributedConfigFromRequest(value);

    expect(local).toMatchObject({
      fps: { num: 30, den: 1 },
      quality: "high",
      format: "mp4",
      variables: value.options.variables,
      producerConfig: { protocolTimeout: 123_456 },
    });
    expect(distributed).toMatchObject({
      fps: 30,
      width: 1920,
      height: 1080,
      format: "mp4",
      chunkSize: 120,
      variables: value.options.variables,
      producerConfig: { protocolTimeout: 123_456 },
    });
  });

  it("round-trips distributed adapter fields back into the shared request", () => {
    const value = request();
    const distributed = distributedConfigFromRequest(value);
    const reconstructed = renderRequestFromDistributedConfig({
      projectDir: value.projectDir,
      outputPath: value.outputPath,
      config: distributed,
    });

    expect(reconstructed.options).toMatchObject({
      fps: value.options.fps,
      quality: value.options.quality,
      format: value.options.format,
      entryFile: value.options.entryFile,
      variables: value.options.variables,
      distributed: value.options.distributed,
    });
  });

  it("snapshots environment-derived engine options once at the boundary", () => {
    process.env.PRODUCER_FORCE_SCREENSHOT = "true";
    const value = createRenderRequest({
      projectDir: "/project",
      outputPath: "/output/video.mp4",
      options: { fps: { num: 30, den: 1 }, quality: "standard", format: "mp4" },
    });
    process.env.PRODUCER_FORCE_SCREENSHOT = "false";

    expect(value.options.engineConfig.forceScreenshot).toBe(true);
    expect(renderConfigFromRequest(value).producerConfig?.forceScreenshot).toBe(true);
  });

  it("rejects unsupported distributed fps before an adapter launch", () => {
    const value = request();
    value.options.fps = { num: 30_000, den: 1_001 };
    expect(() => distributedConfigFromRequest(value)).toThrow("does not support fps");
  });
});
