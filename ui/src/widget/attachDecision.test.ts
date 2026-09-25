import { describe, expect, it } from "vitest";

import { chooseForEmpty, chooseForManifest } from "./attachDecision";
import type { LiveSessionFacts } from "./attachDecision";

const facts = (over: Partial<LiveSessionFacts>): LiveSessionFacts => ({
  owner: "none",
  matchesRecent: false,
  handedOff: false,
  ...over,
});

describe("chooseForManifest", () => {
  it("restores from files when no session is live", () => {
    expect(chooseForManifest(null)).toBe("restore");
  });

  it("re-attaches a detached session whose recent state matches (tab switch)", () => {
    expect(chooseForManifest(facts({ matchesRecent: true }))).toBe("reuse");
  });

  it("restores an older manifest when the session was not handed off (reopened file)", () => {
    expect(chooseForManifest(facts({}))).toBe("restore");
  });

  it("keeps a handed-off session even for an older manifest (graph undo)", () => {
    expect(chooseForManifest(facts({ handedOff: true }))).toBe("reuse");
    expect(chooseForManifest(facts({ owner: "self", handedOff: true }))).toBe("reuse");
  });

  it("forks when another live node shows the session (copy/paste)", () => {
    expect(chooseForManifest(facts({ owner: "other", matchesRecent: true }))).toBe("fork-copy");
    expect(chooseForManifest(facts({ owner: "other" }))).toBe("fork-restore");
    expect(chooseForManifest(facts({ owner: "other", handedOff: true }))).toBe("fork-restore");
  });
});

describe("chooseForEmpty", () => {
  it("always resets on an unreadable value", () => {
    expect(chooseForEmpty("invalid", { hasPaint: false, handoff: true })).toBe("reset");
  });

  it("adopts a waiting handed-off session (graph undo to before the first stroke)", () => {
    expect(chooseForEmpty("empty", { hasPaint: false, handoff: true })).toBe("adopt");
  });

  it("resets painted sessions and keeps untouched ones otherwise", () => {
    expect(chooseForEmpty("empty", { hasPaint: true, handoff: false })).toBe("reset");
    expect(chooseForEmpty("empty", { hasPaint: false, handoff: false })).toBe("keep");
  });
});
