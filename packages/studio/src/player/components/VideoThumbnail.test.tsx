// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoThumbnail } from "./VideoThumbnail";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

// Fire "intersecting" immediately on observe so the extraction effect runs.
class MockIntersectionObserver {
  private cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
  }
  observe() {
    this.cb(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  disconnect() {}
  unobserve() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

class MockResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

const originalIO = globalThis.IntersectionObserver;
const originalRO = globalThis.ResizeObserver;

let host: HTMLDivElement;
let root: Root | null = null;
let createdVideos: HTMLVideoElement[];

beforeEach(() => {
  globalThis.IntersectionObserver =
    MockIntersectionObserver as unknown as typeof IntersectionObserver;
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

  createdVideos = [];
  const origCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreate(tag);
    if (tag === "video") createdVideos.push(el as HTMLVideoElement);
    return el;
  });

  // happy-dom's <video>/<canvas> don't decode media; stub the seam the
  // extractor depends on so the effect can run deterministically.
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: () => {},
  } as unknown as CanvasRenderingContext2D);

  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  globalThis.IntersectionObserver = originalIO;
  globalThis.ResizeObserver = originalRO;
  document.body.innerHTML = "";
});

function render(videoSrc: string) {
  root = createRoot(host);
  act(() => {
    root!.render(React.createElement(VideoThumbnail, { videoSrc, label: "", labelColor: "#fff" }));
  });
}

function lastVideo(): HTMLVideoElement {
  const v = createdVideos.at(-1);
  expect(v).toBeDefined();
  return v!;
}

describe("VideoThumbnail — tainted-canvas fallback", () => {
  it("stops the extractor and drops the shimmer when toDataURL throws a SecurityError", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
      throw new DOMException("Tainted canvases may not be exported.", "SecurityError");
    });

    render("https://cdn.example.com/no-cors.mp4");

    // The effect ran once visible → a hidden <video> was created.
    const video = lastVideo();

    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    // No frame captured, and crucially the shimmer is gone (not spinning
    // forever) — the clip falls back to its plain background.
    expect(host.querySelectorAll("img").length).toBe(0);
    expect(host.querySelector(".animate-pulse")).toBeNull();
  });

  it("keeps streaming frames while the shimmer is up until a frame arrives", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/jpeg;base64,AAAA",
    );

    render("/api/projects/p/preview/assets/clip.mp4");
    // Before any seek resolves, the shimmer placeholder is shown.
    expect(host.querySelector(".animate-pulse")).not.toBeNull();

    const video = lastVideo();
    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    // A frame was captured, so tiles render and the shimmer clears.
    expect(host.querySelectorAll("img").length).toBeGreaterThanOrEqual(1);
    expect(host.querySelector(".animate-pulse")).toBeNull();
  });
});
