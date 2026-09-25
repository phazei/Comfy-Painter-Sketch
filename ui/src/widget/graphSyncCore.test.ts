import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoalescedTask, captureTrackerState, isInRootGraph } from "./graphSyncCore";
import type { GraphLike } from "./graphSyncCore";

describe("CoalescedTask", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs once after a burst of schedules", () => {
    const run = vi.fn();
    const task = new CoalescedTask(run);
    task.schedule(1000);
    vi.advanceTimersByTime(600);
    task.schedule(1000);
    vi.advanceTimersByTime(600);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(run).toHaveBeenCalledTimes(1);
    expect(task.pending).toBe(false);
  });

  it("a shorter schedule replaces a longer pending one", () => {
    const run = vi.fn();
    const task = new CoalescedTask(run);
    task.schedule(1000);
    task.schedule(0);
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("flush runs a pending call synchronously, once", () => {
    const run = vi.fn();
    const task = new CoalescedTask(run);
    task.schedule(1000);
    task.flush();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("flush and cancel are no-ops when nothing is pending", () => {
    const run = vi.fn();
    const task = new CoalescedTask(run);
    task.flush();
    task.schedule(10);
    task.cancel();
    task.flush();
    vi.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("captureTrackerState", () => {
  it("prefers captureCanvasState over the deprecated checkState", () => {
    const tracker = { captureCanvasState: vi.fn(), checkState: vi.fn() };
    expect(captureTrackerState(tracker)).toBe(true);
    expect(tracker.captureCanvasState).toHaveBeenCalledTimes(1);
    expect(tracker.checkState).not.toHaveBeenCalled();
  });

  it("falls back to checkState on older frontends", () => {
    const tracker = { checkState: vi.fn() };
    expect(captureTrackerState(tracker)).toBe(true);
    expect(tracker.checkState).toHaveBeenCalledTimes(1);
  });

  it("reports when no capture method exists", () => {
    expect(captureTrackerState({})).toBe(false);
  });
});

describe("isInRootGraph", () => {
  const root: GraphLike = {};
  root.rootGraph = root;
  const subgraph: GraphLike = { rootGraph: root };
  const otherRoot: GraphLike = {};

  it("matches the root itself and its subgraphs", () => {
    expect(isInRootGraph(root, root)).toBe(true);
    expect(isInRootGraph(subgraph, root)).toBe(true);
  });

  it("matches a root graph without a rootGraph property", () => {
    expect(isInRootGraph(otherRoot, otherRoot)).toBe(true);
  });

  it("rejects detached nodes and other workflows' graphs", () => {
    expect(isInRootGraph(null, root)).toBe(false);
    expect(isInRootGraph(subgraph, null)).toBe(false);
    expect(isInRootGraph(otherRoot, root)).toBe(false);
  });
});
