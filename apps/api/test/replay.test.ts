import { afterEach, describe, expect, it, vi } from "vitest";

import { createApi, type ApiRuntime } from "../src/app.js";

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

    const started = runtime.engine.run();
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

    const paused = runtime.engine.pause();
    expect(paused.replay.running).toBe(false);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(runtime.engine.snapshot().replay.cursor).toBe(1);
  });
});
