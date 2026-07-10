import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CanvasResolution, OutputResolutionIssueKind } from "@hyperframes/core";
import { c } from "../../ui/colors.js";
import { errorBox, formatBytes } from "../../ui/format.js";
import { formatLintFindings } from "../../utils/lintFormat.js";
import { lintProject, shouldBlockRender } from "../../utils/lintProject.js";
import { normalizeErrorMessage } from "../../utils/errorMessage.js";
import { failCommand, setCommandExitCode } from "../../utils/commandResult.js";
import {
  reportVariableIssues,
  resolveVariablesArg,
  validateVariablesAgainstProject,
} from "../../utils/variables.js";
import { trackRenderPreflightRejected } from "../../telemetry/events.js";
import { applyRenderEnvironment, renderOutputDirectory, type RenderPlan } from "./plan.js";
import type { RenderOptions, SingleRenderResult } from "../render.js";

type RenderExecutor = (
  projectDir: string,
  outputPath: string,
  options: RenderOptions,
) => Promise<SingleRenderResult>;

type ResolutionPreflight = (
  compositionHtml: string,
  outputResolution: CanvasResolution | undefined,
  modes: { alphaRequested: boolean; hdrRequested: boolean },
) => Promise<{ message: string; kind: OutputResolutionIssueKind } | undefined>;

export interface RenderExecutionDependencies {
  renderDocker: RenderExecutor;
  renderLocal: RenderExecutor;
  checkResolution: ResolutionPreflight;
}

export function renderLintContinuationHint(strictErrors: boolean): string {
  return strictErrors
    ? "  Continuing render despite lint warnings. Use --strict-all to block warnings."
    : "  Continuing render despite lint issues. Use --strict to block errors.";
}

/** Execute a validated plan. Output and process lifecycle stay outside parsing. */
export async function executeRenderPlan(
  plan: RenderPlan,
  dependencies: RenderExecutionDependencies,
): Promise<void> {
  applyRenderEnvironment(plan);
  if (!plan.batchPath) mkdirSync(renderOutputDirectory(plan), { recursive: true });

  let batchModule: typeof import("../batchRender.js") | undefined;
  let preparedBatch: import("../batchRender.js").PreparedBatchRender | undefined;
  if (plan.batchPath) {
    batchModule = await import("../batchRender.js");
    try {
      preparedBatch = batchModule.prepareBatchRender({
        batchPath: plan.batchPath,
        outputTemplate: plan.batchOutputTemplate,
        indexPath: plan.project.indexPath,
        strictVariables: plan.strictVariables,
        quiet: plan.quiet || plan.batchJson,
        json: plan.batchJson,
      });
    } catch (error: unknown) {
      batchModule.exitBatchRenderInputError(error);
    }
  }

  const browserPath = plan.useDocker ? undefined : await ensureRenderBrowser(plan);
  await runRenderLint(plan);
  await runResolutionPreflight(plan, dependencies.checkResolution);

  if (plan.batchPath && batchModule && preparedBatch) {
    await executeBatchRender(plan, browserPath, batchModule, preparedBatch, dependencies);
    return;
  }

  const variables = resolveVariablesArg(plan.variablesArg, plan.variablesFileArg);
  if (variables && Object.keys(variables).length > 0) {
    const issues = validateVariablesAgainstProject(plan.project.indexPath, variables);
    reportVariableIssues(issues, { strict: plan.strictVariables, quiet: plan.quiet });
  }

  const options: RenderOptions = {
    fps: plan.fps,
    quality: plan.quality,
    authoringSkill: plan.authoringSkill,
    format: plan.format,
    gifLoop: plan.gifLoop,
    workers: plan.workers,
    gpu: plan.useGpu,
    browserGpuMode: plan.browserGpuMode,
    hdrMode: plan.hdrMode,
    crf: plan.crf,
    vp9CpuUsed: plan.vp9CpuUsed,
    videoBitrate: plan.videoBitrate,
    videoFrameFormat: plan.videoFrameFormat,
    quiet: plan.quiet,
    browserPath,
    debug: plan.debug,
    bestEffort: plan.bestEffort,
    variables,
    entryFile: plan.entryFile,
    outputResolution: plan.outputResolution,
    pageNavigationTimeoutMs: plan.pageNavigationTimeoutMs,
    protocolTimeout: plan.protocolTimeout,
    playerReadyTimeout: plan.playerReadyTimeout,
    exitAfterComplete: true,
    enableDeParallelRouterTrial: true,
  };
  if (plan.useDocker) {
    options.pageSideCompositing = plan.pageSideCompositing;
    options.experimentalFastCapture = plan.experimentalFastCapture;
  }
  const execute = plan.useDocker ? dependencies.renderDocker : dependencies.renderLocal;
  await execute(plan.project.dir, plan.outputPath, options);
}

async function ensureRenderBrowser(plan: RenderPlan): Promise<string> {
  const { ensureBrowser } = await import("../../browser/manager.js");
  let browserSpinner:
    | {
        start: (message?: string) => void;
        message: (message: string) => void;
        stop: (message?: string) => void;
      }
    | undefined;
  try {
    if (plan.effectiveQuiet) {
      return (await ensureBrowser({ preferManagedChrome: true })).executablePath;
    }
    const clack = await import("@clack/prompts");
    browserSpinner = clack.spinner();
    browserSpinner.start("Checking browser...");
    const info = await ensureBrowser({
      preferManagedChrome: true,
      onProgress: (downloaded, total) => {
        if (total <= 0) return;
        const pct = Math.floor((downloaded / total) * 100);
        browserSpinner?.message(
          `Downloading Chrome... ${c.progress(pct + "%")} ${c.dim("(" + formatBytes(downloaded) + " / " + formatBytes(total) + ")")}`,
        );
      },
    });
    browserSpinner.stop(c.dim(`Browser: ${info.source}`));
    return info.executablePath;
  } catch (error: unknown) {
    browserSpinner?.stop(c.error("Browser not available"));
    errorBox(
      "Chrome not found",
      normalizeErrorMessage(error),
      "Run: npx hyperframes browser ensure",
    );
    failCommand();
  }
}

async function runRenderLint(plan: RenderPlan): Promise<void> {
  const lintResult = await lintProject(plan.project.dir);
  if (lintResult.totalErrors === 0 && lintResult.totalWarnings === 0) return;
  if (!plan.effectiveQuiet) {
    console.log("");
    for (const line of formatLintFindings(lintResult, { errorsFirst: true })) console.log(line);
  }
  if (
    shouldBlockRender(
      plan.strictErrors,
      plan.strictAll,
      lintResult.totalErrors,
      lintResult.totalWarnings,
    )
  ) {
    const mode = plan.strictAll ? "--strict-all" : "--strict";
    if (!plan.effectiveQuiet) {
      console.log("");
      console.log(c.error(`  Aborting render due to lint issues (${mode} mode).`));
      console.log("");
    }
    failCommand();
  }
  if (!plan.effectiveQuiet) {
    console.log(c.dim(renderLintContinuationHint(plan.strictErrors)));
    console.log("");
  }
}

async function runResolutionPreflight(
  plan: RenderPlan,
  checkResolution: ResolutionPreflight,
): Promise<void> {
  if (!plan.outputResolution) return;
  let issue: { message: string; kind: OutputResolutionIssueKind } | undefined;
  try {
    const renderTarget = plan.entryFile
      ? resolve(plan.project.dir, plan.entryFile)
      : plan.project.indexPath;
    issue = await checkResolution(readFileSync(renderTarget, "utf8"), plan.outputResolution, {
      alphaRequested:
        plan.format === "webm" || plan.format === "mov" || plan.format === "png-sequence",
      hdrRequested: plan.hdrMode === "force-hdr",
    });
  } catch {
    // Unreadable input is surfaced by the render pipeline with full context.
  }
  if (!issue) return;
  trackRenderPreflightRejected({ kind: issue.kind });
  errorBox("Output resolution incompatible", issue.message);
  failCommand();
}

async function executeBatchRender(
  plan: RenderPlan,
  browserPath: string | undefined,
  batchModule: typeof import("../batchRender.js"),
  preparedBatch: import("../batchRender.js").PreparedBatchRender,
  dependencies: RenderExecutionDependencies,
): Promise<void> {
  const batchQuiet = plan.quiet || plan.batchJson;
  const renderOptionsBase: RenderOptions = {
    fps: plan.fps,
    quality: plan.quality,
    authoringSkill: plan.authoringSkill,
    format: plan.format,
    workers: plan.workers,
    gpu: plan.useGpu,
    browserGpuMode: plan.browserGpuMode,
    hdrMode: plan.hdrMode,
    crf: plan.crf,
    vp9CpuUsed: plan.vp9CpuUsed,
    videoBitrate: plan.videoBitrate,
    quiet: batchQuiet,
    browserPath,
    entryFile: plan.entryFile,
    outputResolution: plan.outputResolution,
    pageNavigationTimeoutMs: plan.pageNavigationTimeoutMs,
    protocolTimeout: plan.protocolTimeout,
    playerReadyTimeout: plan.playerReadyTimeout,
    debug: plan.debug,
    bestEffort: plan.bestEffort,
    exitAfterComplete: false,
    throwOnError: true,
    skipFeedback: true,
    enableDeParallelRouterTrial: plan.batchConcurrency <= 1,
  };
  const manifest = await batchModule.runBatchRender({
    prepared: preparedBatch,
    concurrency: plan.batchConcurrency,
    failFast: plan.batchFailFast,
    quiet: batchQuiet,
    json: plan.batchJson,
    renderOne: (row) => {
      const options: RenderOptions = { ...renderOptionsBase, variables: row.variables };
      if (plan.useDocker) options.pageSideCompositing = plan.pageSideCompositing;
      const execute = plan.useDocker ? dependencies.renderDocker : dependencies.renderLocal;
      return execute(plan.project.dir, row.outputPath, options);
    },
  });
  if (manifest.failed > 0) setCommandExitCode(1);
}
