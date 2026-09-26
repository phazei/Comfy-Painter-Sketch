import { describe, expect, it } from "vitest";

import {
  classifyError,
  classifyStatus,
  cleanupFailureReason,
  DecodeError,
  EncodeError,
  HttpError,
  invalidDocumentMessage,
  restoreSummary,
  serverErrorMessage,
  uploadFailureMessage,
} from "./failures";

describe("classifyStatus / classifyError", () => {
  it("maps HTTP statuses", () => {
    expect(classifyStatus(0)).toBe("offline");
    expect(classifyStatus(404)).toBe("missing");
    expect(classifyStatus(405)).toBe("missing");
    expect(classifyStatus(413)).toBe("tooLarge");
    expect(classifyStatus(400)).toBe("rejected");
    expect(classifyStatus(403)).toBe("rejected");
    expect(classifyStatus(500)).toBe("server");
    expect(classifyStatus(503)).toBe("server");
    expect(classifyStatus(302)).toBe("unexpected");
  });

  it("maps thrown values", () => {
    expect(classifyError(new TypeError("Failed to fetch"))).toBe("offline");
    expect(classifyError(new HttpError(507, "Insufficient Storage"))).toBe("server");
    expect(classifyError(new EncodeError("Layer 1"))).toBe("encode");
    expect(classifyError(new DecodeError("/view?x"))).toBe("unreadable");
    expect(classifyError(new Error("boom"))).toBe("unexpected");
    expect(classifyError("boom")).toBe("unexpected");
  });
});

describe("serverErrorMessage", () => {
  it("reads a JSON error field only", () => {
    expect(serverErrorMessage({ error: "body must be JSON" })).toBe("body must be JSON");
    expect(serverErrorMessage({ error: "  " })).toBeUndefined();
    expect(serverErrorMessage({ error: 3 })).toBeUndefined();
    expect(serverErrorMessage(null)).toBeUndefined();
  });
});

describe("uploadFailureMessage", () => {
  it("names the cause and says the paint is kept", () => {
    const offline = uploadFailureMessage(new TypeError("Failed to fetch"));
    expect(offline).toContain("server is unreachable");
    expect(offline).toContain("kept in the editor");
    expect(uploadFailureMessage(new HttpError(413, "Payload Too Large"))).toContain("too large");
    expect(uploadFailureMessage(new HttpError(500, "Internal Server Error"))).toContain("disk full");
    expect(uploadFailureMessage(new HttpError(400, "Bad Request", "invalid subfolder"))).toContain("invalid subfolder");
    expect(uploadFailureMessage(new EncodeError("Sky"))).toContain('"Sky"');
  });
});

describe("cleanupFailureReason", () => {
  it("explains a missing route (Python side not loaded)", () => {
    expect(cleanupFailureReason(new HttpError(404, "Not Found"))).toContain("Python node probably failed to load");
    expect(cleanupFailureReason(new HttpError(405, "Method Not Allowed"))).toContain("not available");
  });

  it("shows the route's JSON error", () => {
    expect(cleanupFailureReason(new HttpError(400, "Bad Request", "'dryRun' must be a boolean"))).toBe(
      "'dryRun' must be a boolean",
    );
    expect(cleanupFailureReason(new HttpError(500, "", "cleanup failed on the server: disk"))).toContain("disk");
    expect(cleanupFailureReason(new HttpError(500, ""))).toContain("ComfyUI console");
    expect(cleanupFailureReason(new TypeError("Failed to fetch"))).toContain("unreachable");
  });
});

describe("invalidDocumentMessage", () => {
  it("says the data is kept and hints at a version mismatch", () => {
    const newer = invalidDocumentMessage("unsupported document version 2");
    expect(newer).toContain("newer PainterSketch");
    expect(newer).toContain("kept in the workflow");
    expect(invalidDocumentMessage("document is not valid JSON")).not.toContain("newer");
  });
});

describe("restoreSummary", () => {
  it("is null without problems", () => {
    expect(restoreSummary([])).toBeNull();
  });

  it("aggregates missing files into one warning", () => {
    const summary = restoreSummary([
      { name: "Layer 1", kind: "missing" },
      { name: "Mask", kind: "missing" },
    ]);
    expect(summary?.severity).toBe("warn");
    expect(summary?.message).toContain("2 layers lost their file");
    expect(summary?.message).toContain('"Layer 1", "Mask"');
    expect(summary?.message).toContain("references are kept");
  });

  it("is an error when the server was unreachable (painting would replace recoverable files)", () => {
    const summary = restoreSummary([
      { name: "A", kind: "offline" },
      { name: "B", kind: "missing" },
    ]);
    expect(summary?.severity).toBe("error");
    expect(summary?.message).toContain("server is unreachable");
    expect(summary?.message).toContain("Reload the workflow");
    expect(summary?.message).toContain("1 layer lost its file");
  });

  it("truncates long name lists", () => {
    const problems = ["a", "b", "c", "d", "e"].map((name) => ({ name, kind: "unreadable" as const }));
    expect(restoreSummary(problems)?.message).toContain('"a", "b", "c" +2 more');
  });

  it("reports stale sizes without the kept-reference sentence", () => {
    const summary = restoreSummary([{ name: "Old", kind: "stale" }]);
    expect(summary?.severity).toBe("warn");
    expect(summary?.message).toContain("older canvas size");
    expect(summary?.message).not.toContain("references are kept");
  });
});
