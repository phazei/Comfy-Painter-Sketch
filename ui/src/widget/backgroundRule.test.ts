/**
 * Pure background / Image Mask rules (`backgroundRule.ts`).
 */

import { describe, expect, it } from "vitest";

import {
  backgroundStatus,
  chooseBackgroundSource,
  executedLinkOf,
  forgetExecutedLink,
  imageMaskAction,
  linkIdentity,
  recordExecutedLink,
} from "./backgroundRule";
import type { BackgroundStatus } from "./backgroundRule";
import type { LoadedBackground } from "./handoff";
import type { ImageSource } from "./imageSource";

const up: ImageSource = { key: "up.png", url: "/view?up", origin: "upstream" };
const ex: ImageSource = { key: "run.png", url: "/view?run", origin: "executed" };

function loaded(key: string, origin: "upstream" | "executed" = "upstream"): LoadedBackground {
  return { key, image: {} as HTMLImageElement, size: { width: 1, height: 1 }, origin, alphaUrl: null };
}

describe("chooseBackgroundSource", () => {
  it("upstream first; executed only for its own link; nothing when disconnected", () => {
    const link = linkIdentity("", "4", 0);
    expect(chooseBackgroundSource({ upstream: up, executed: ex, executedLink: link, link })).toBe(up);
    expect(chooseBackgroundSource({ upstream: null, executed: ex, executedLink: link, link })).toBe(ex);
    expect(chooseBackgroundSource({ upstream: null, executed: ex, executedLink: linkIdentity("", "4", 1), link })).toBeNull();
    expect(chooseBackgroundSource({ upstream: null, executed: ex, executedLink: undefined, link })).toBeNull();
    expect(chooseBackgroundSource({ upstream: up, executed: ex, executedLink: link, link: null })).toBeNull();
  });

  it("link identity separates node, slot and subgraph", () => {
    const ids = new Set([linkIdentity("", "4", 0), linkIdentity("", "4", 1), linkIdentity("", "5", 0), linkIdentity("sub:", "4", 0)]);
    expect(ids.size).toBe(4);
  });

  it("provenance store remembers and forgets", () => {
    recordExecutedLink("k", "L");
    expect(executedLinkOf("k")).toBe("L");
    forgetExecutedLink("k");
    expect(executedLinkOf("k")).toBeUndefined();
  });
});

describe("backgroundStatus", () => {
  it("a cached image of another key is never loaded/shown", () => {
    const cached = loaded("lastLoadImage.png");
    expect(backgroundStatus({ resolved: true, current: null, loaded: cached, pendingKey: null }).kind).toBe("none");
    expect(backgroundStatus({ resolved: true, current: { key: "x", origin: "upstream" }, loaded: cached, pendingKey: null }).kind).toBe("none");
    expect(backgroundStatus({ resolved: true, current: { key: "x", origin: "upstream" }, loaded: cached, pendingKey: "x" }).kind).toBe("loading");
    expect(backgroundStatus({ resolved: false, current: null, loaded: cached, pendingKey: null }).kind).toBe("unresolved");
    expect(backgroundStatus({ resolved: true, current: { key: "lastLoadImage.png", origin: "upstream" }, loaded: cached, pendingKey: null }).kind).toBe("loaded");
  });
});

describe("imageMaskAction", () => {
  const cases: [BackgroundStatus, string | undefined, string][] = [
    [{ kind: "unresolved" }, "a", "keep"],
    [{ kind: "none" }, "a", "remove"],
    [{ kind: "loading", key: "a", origin: "upstream" }, "a", "keep"],
    [{ kind: "loading", key: "b", origin: "upstream" }, "a", "remove"],
    [{ kind: "loading", key: "run", origin: "executed" }, "a", "keep"],
    [{ kind: "loaded", background: loaded("a") }, "a", "read"],
    [{ kind: "loaded", background: loaded("run", "executed") }, "a", "keep"],
  ];
  it.each(cases)("%o with row %s -> %s", (status, row, action) => {
    expect(imageMaskAction(status, row)).toBe(action);
  });
});
