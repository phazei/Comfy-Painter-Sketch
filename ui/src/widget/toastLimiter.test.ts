import { describe, expect, it } from "vitest";

import { DEFAULT_TOAST_WINDOW_MS, ToastLimiter } from "./toastLimiter";

function limiterAt(): { limiter: ToastLimiter; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { limiter: new ToastLimiter(() => t), advance: (ms) => (t += ms) };
}

describe("ToastLimiter", () => {
  it("shows a key once per window", () => {
    const { limiter, advance } = limiterAt();
    expect(limiter.shouldShow("a")).toBe(true);
    advance(DEFAULT_TOAST_WINDOW_MS - 1);
    expect(limiter.shouldShow("a")).toBe(false);
    advance(1);
    expect(limiter.shouldShow("a")).toBe(true);
  });

  it("does not extend the window on suppressed repeats (5 s idle retries)", () => {
    const { limiter, advance } = limiterAt();
    const shown: boolean[] = [];
    for (let i = 0; i < 13; i++) {
      shown.push(limiter.shouldShow("upload", 60_000));
      advance(5_000);
    }
    // t = 0 and t = 60 s.
    expect(shown.filter(Boolean)).toHaveLength(2);
    expect(shown[0]).toBe(true);
    expect(shown[12]).toBe(true);
  });

  it("keeps keys independent and honours per-call windows", () => {
    const { limiter, advance } = limiterAt();
    expect(limiter.shouldShow("a", 1000)).toBe(true);
    expect(limiter.shouldShow("b", 1000)).toBe(true);
    advance(500);
    expect(limiter.shouldShow("a", 1000)).toBe(false);
    expect(limiter.shouldShow("a", 100)).toBe(true);
  });

  it("reset lets the next occurrence through", () => {
    const { limiter } = limiterAt();
    expect(limiter.shouldShow("a")).toBe(true);
    limiter.reset("a");
    expect(limiter.shouldShow("a")).toBe(true);
  });

  it("stays bounded when many distinct keys are used", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 200; i++) limiter.shouldShow(`k${i}`);
    // The oldest keys were forgotten, the newest are still suppressed.
    expect(limiter.shouldShow("k0")).toBe(true);
    expect(limiter.shouldShow("k199")).toBe(false);
  });
});
