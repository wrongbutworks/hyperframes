import { describe, expect, it } from "vitest";
import { isMissingCloudRunAdapterError, missingCloudRunAdapterMessage } from "./cloudrun.js";

describe("Cloud Run adapter preflight", () => {
  it("identifies only the missing adapter, not a missing transitive dependency", () => {
    const adapterError = Object.assign(
      new Error("Cannot find package '@hyperframes/gcp-cloud-run' imported from cli.js"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    const transitiveError = Object.assign(new Error("Cannot find package 'google-auth-library'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });

    expect(isMissingCloudRunAdapterError(adapterError)).toBe(true);
    expect(isMissingCloudRunAdapterError(transitiveError)).toBe(false);
  });

  it("provides global and project-local install recovery commands", () => {
    const message = missingCloudRunAdapterMessage("deploy");
    expect(message).toContain("hyperframes cloudrun deploy");
    expect(message).toContain("npm install -g @hyperframes/gcp-cloud-run");
    expect(message).toContain("npm install @hyperframes/gcp-cloud-run");
  });
});
