import type { ProducerLogger } from "../../logger.js";
import type { ProgressCallback, RenderJob } from "../renderOrchestrator.js";

function snapshotJob(job: RenderJob): RenderJob {
  return {
    ...job,
    warnings: job.warnings.map((warning) => ({
      ...warning,
      details: warning.details
        ? {
            ...warning.details,
            sources: warning.details.sources ? [...warning.details.sources] : undefined,
          }
        : undefined,
    })),
  };
}

/** Serializes progress delivery and contains sink failures at the boundary. */
export class OrderedRenderEventPublisher {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly sink: ProgressCallback | undefined,
    private readonly log: ProducerLogger,
  ) {}

  publish(job: RenderJob, message: string): void {
    if (!this.sink) return;
    const snapshot = snapshotJob(job);
    this.tail = this.tail
      .then(() => this.sink?.(snapshot, message))
      .then(() => undefined)
      .catch((error: unknown) => {
        try {
          this.log.warn("Render event sink rejected an update", {
            status: snapshot.status,
            progress: snapshot.progress,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // A broken logger must not reopen the contained sink failure.
        }
      });
  }

  async flush(): Promise<void> {
    await this.tail;
  }
}
