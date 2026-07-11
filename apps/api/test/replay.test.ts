import { afterEach, describe, expect, it, vi } from "vitest";

import { createApi, type ApiRuntime } from "../src/app.js";
import { DemoAnchorService } from "../src/anchor.js";

describe("ReplayEngine timing", () => {
  let runtime: ApiRuntime | undefined;

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    vi.useRealTimers();
  });

  it("advances one replay frame per 650ms tick and can pause", async () => {
    vi.useFakeTimers();
    runtime = createApi({ env: { NODE_ENV: "test" } });

    const started = await runtime.engine.run();
    expect(started.replay).toMatchObject({
      running: true,
      cursor: 0,
      intervalMs: 650,
    });

    await vi.advanceTimersByTimeAsync(649);
    expect(runtime.engine.snapshot().replay.cursor).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.engine.snapshot().replay.cursor).toBe(1);
    expect(runtime.engine.snapshot().match.status).toBe("live");

    const paused = await runtime.engine.pause();
    expect(paused.replay.running).toBe(false);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(runtime.engine.snapshot().replay.cursor).toBe(1);
  });

  it("serializes pause and reset behind an in-flight anchor", async () => {
    const anchorService = new DemoAnchorService();
    const originalAnchor = anchorService.anchor.bind(anchorService);
    let releaseAnchor!: () => void;
    const anchorGate = new Promise<void>((resolve) => {
      releaseAnchor = resolve;
    });
    vi.spyOn(anchorService, "anchor").mockImplementation(async (input) => {
      await anchorGate;
      return originalAnchor(input);
    });
    runtime = createApi({
      env: { NODE_ENV: "test" },
      anchorService,
    });

    for (let index = 0; index < runtime.dataset.frames.length - 1; index += 1) {
      await runtime.engine.step();
    }
    const anchoring = runtime.engine.step();
    await vi.waitFor(() => {
      expect(runtime?.engine.snapshot().replay).toMatchObject({
        cursor: 15,
        processing: true,
      });
    });

    const paused = runtime.engine.pause();
    const reset = runtime.engine.reset();
    releaseAnchor();

    await expect(anchoring).resolves.toMatchObject({
      replay: { cursor: 15, processing: false },
    });
    await expect(paused).resolves.toMatchObject({
      replay: { cursor: 15, processing: false },
      events: expect.arrayContaining([
        expect.objectContaining({
          eventId: "final-result",
          anchor: expect.objectContaining({
            receipt: expect.objectContaining({ confirmed: true }),
          }),
        }),
      ]),
    });
    await expect(reset).resolves.toMatchObject({
      replay: { cursor: 0, processing: false },
      events: [],
      anchors: [],
      errors: [],
    });
    expect(runtime.engine.snapshot().replay.processedFrameIds).toEqual([]);
  });

  it("stops a run that was queued immediately before pause or reset", async () => {
    vi.useFakeTimers();
    runtime = createApi({ env: { NODE_ENV: "test" } });

    const firstReset = runtime.engine.reset();
    const queuedRun = runtime.engine.run();
    const queuedPause = runtime.engine.pause();
    await firstReset;
    await expect(queuedRun).resolves.toMatchObject({
      replay: { running: true, cursor: 0 },
    });
    await expect(queuedPause).resolves.toMatchObject({
      replay: { running: false, cursor: 0 },
    });
    await vi.advanceTimersByTimeAsync(1_300);
    expect(runtime.engine.snapshot().replay).toMatchObject({
      running: false,
      cursor: 0,
    });

    const secondReset = runtime.engine.reset();
    const secondRun = runtime.engine.run();
    const finalReset = runtime.engine.reset();
    await secondReset;
    await expect(secondRun).resolves.toMatchObject({
      replay: { running: true, cursor: 0 },
    });
    await expect(finalReset).resolves.toMatchObject({
      replay: { running: false, cursor: 0 },
    });
    await vi.advanceTimersByTimeAsync(1_300);
    expect(runtime.engine.snapshot().replay).toMatchObject({
      running: false,
      cursor: 0,
      processedFrameIds: [],
    });
  });

  it("executes a step queued after reset against the new replay state", async () => {
    runtime = createApi({ env: { NODE_ENV: "test" } });

    const oldStep = runtime.engine.step();
    const reset = runtime.engine.reset();
    const newStep = runtime.engine.step();

    await expect(oldStep).resolves.toMatchObject({ replay: { cursor: 1 } });
    await expect(reset).resolves.toMatchObject({ replay: { cursor: 0 } });
    await expect(newStep).resolves.toMatchObject({ replay: { cursor: 1 } });
    expect(runtime.engine.snapshot().replay.cursor).toBe(1);
    expect(runtime.engine.snapshot().replay.processedFrameIds).toHaveLength(1);
  });
});
