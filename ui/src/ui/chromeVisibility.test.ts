/**
 * Chrome visibility timing: hover shows after a delay, deliberate shows are
 * immediate, hides wait a grace and are held by a hovered element.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChromeVisibility, HIDE_GRACE_MS, SHOW_DELAY_MS } from "./chromeVisibility";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function make(): { chrome: ChromeVisibility; log: boolean[] } {
  const log: boolean[] = [];
  const chrome = new ChromeVisibility((shown) => log.push(shown));
  return { chrome, log };
}

describe("ChromeVisibility", () => {
  it("a hover show waits the delay; a hide waits the grace", () => {
    const { chrome, log } = make();
    chrome.request(true);
    vi.advanceTimersByTime(SHOW_DELAY_MS - 1);
    expect(chrome.visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(chrome.visible).toBe(true);
    chrome.request(false);
    vi.advanceTimersByTime(HIDE_GRACE_MS - 1);
    expect(chrome.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(chrome.visible).toBe(false);
    expect(log).toEqual([true, false]);
  });

  it("the show delay is three times the hide grace", () => {
    expect(SHOW_DELAY_MS).toBe(3 * HIDE_GRACE_MS);
  });

  it("a deliberate show is immediate, also during a pending hover show", () => {
    const { chrome } = make();
    chrome.request(true, true);
    expect(chrome.visible).toBe(true);
    chrome.request(false);
    vi.advanceTimersByTime(HIDE_GRACE_MS);
    chrome.request(true);
    vi.advanceTimersByTime(10);
    expect(chrome.visible).toBe(false);
    chrome.request(true, true);
    expect(chrome.visible).toBe(true);
  });

  it("leaving before the delay cancels the show (crossing the node)", () => {
    const { chrome, log } = make();
    chrome.request(true);
    vi.advanceTimersByTime(SHOW_DELAY_MS / 2);
    chrome.request(false);
    vi.advanceTimersByTime(SHOW_DELAY_MS * 2);
    expect(log).toEqual([]);
  });

  it("a show during the hide grace keeps it up", () => {
    const { chrome, log } = make();
    chrome.request(true, true);
    chrome.request(false);
    chrome.request(true);
    vi.advanceTimersByTime(HIDE_GRACE_MS * 2);
    expect(chrome.visible).toBe(true);
    expect(log).toEqual([true]);
  });

  it("entering a held element cancels the hide; leaving restarts the grace", () => {
    const { chrome } = make();
    const element = new EventTarget() as HTMLElement;
    chrome.hold(element);
    chrome.request(true, true);
    chrome.request(false);
    element.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(HIDE_GRACE_MS * 4);
    expect(chrome.visible).toBe(true);
    element.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(HIDE_GRACE_MS);
    expect(chrome.visible).toBe(false);
  });

  it("dispose cancels a pending change", () => {
    const { chrome, log } = make();
    chrome.request(true);
    chrome.dispose();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(log).toEqual([]);
  });
});
