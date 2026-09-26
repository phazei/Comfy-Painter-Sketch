/**
 * Failure classification and user-facing wording for server/browser errors
 * (upload, layer restore, cleanup route). Pure (no ComfyUI imports), so the
 * status -> message mapping is unit-testable. Callers toast the result via
 * `toast.ts` and log the raw error to the console.
 */

// ── Error types ───────────────────────────────────────────────────────────────

/** A server answered with a non-success HTTP status. */
export class HttpError extends Error {
  /**
   * @param status - HTTP status code.
   * @param statusText - HTTP status text.
   * @param serverMessage - `error` field of a JSON error body, if any.
   */
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly serverMessage?: string,
  ) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ""}${serverMessage ? `: ${serverMessage}` : ""}`);
    this.name = "HttpError";
  }
}

/** The browser could not encode a layer canvas (`toBlob` returned `null`). */
export class EncodeError extends Error {
  /** @param layerName - Layer that failed to encode. */
  constructor(readonly layerName: string) {
    super(`could not encode layer "${layerName}"`);
    this.name = "EncodeError";
  }
}

/** A downloaded layer file could not be decoded as an image. */
export class DecodeError extends Error {
  /** @param url - Image URL (console detail). */
  constructor(url: string) {
    super(`could not decode ${url}`);
    this.name = "DecodeError";
  }
}

// ── Classification ────────────────────────────────────────────────────────────

/** What went wrong, as far as the user needs to know. */
export type FailureKind =
  /** Network failure: server stopped / unreachable. */
  | "offline"
  /** 404 / 405: file or route does not exist. */
  | "missing"
  /** 413: request too large. */
  | "tooLarge"
  /** Other 4xx. */
  | "rejected"
  /** 5xx. */
  | "server"
  /** Browser could not encode a canvas. */
  | "encode"
  /** Downloaded bytes are not a decodable image. */
  | "unreadable"
  /** Anything else (bug, unexpected response). */
  | "unexpected";

/**
 * Classify an HTTP status code.
 * @param status - HTTP status (0 = no response).
 * @returns The failure kind.
 */
export function classifyStatus(status: number): FailureKind {
  if (status === 0) return "offline";
  if (status === 404 || status === 405) return "missing";
  if (status === 413) return "tooLarge";
  if (status >= 400 && status < 500) return "rejected";
  if (status >= 500) return "server";
  return "unexpected";
}

/**
 * Classify a thrown value. `fetch` rejects with a `TypeError` on network
 * failure (server down, connection refused, CORS/offline).
 * @param error - Caught value.
 * @returns The failure kind.
 */
export function classifyError(error: unknown): FailureKind {
  if (error instanceof HttpError) return classifyStatus(error.status);
  if (error instanceof EncodeError) return "encode";
  if (error instanceof DecodeError) return "unreadable";
  if (error instanceof TypeError) return "offline";
  return "unexpected";
}

/**
 * Extract the `error` string of a JSON error body (`{"error": "..."}`).
 * @param data - Parsed body (or `null`).
 * @returns The message, if present.
 */
export function serverErrorMessage(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = (data as { error?: unknown }).error;
  return typeof message === "string" && message.trim() ? message : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Upload ────────────────────────────────────────────────────────────────────

/**
 * Toast text for a failed layer upload (data at risk: pixels only in memory).
 * @param error - The first failure of the batch.
 * @returns One actionable sentence pair.
 */
export function uploadFailureMessage(error: unknown): string {
  const status = error instanceof HttpError ? error.status : 0;
  let reason: string;
  switch (classifyError(error)) {
    case "offline":
      reason = "the ComfyUI server is unreachable";
      break;
    case "tooLarge":
      reason = "the server rejected the file as too large (HTTP 413)";
      break;
    case "missing":
    case "rejected":
      reason = `the server rejected the upload (${errorText(error)})`;
      break;
    case "server":
      reason = `the server reported an error (HTTP ${status}); check the ComfyUI console (disk full?)`;
      break;
    case "encode":
      reason = `the browser ${errorText(error)} (out of memory? try a smaller canvas)`;
      break;
    default:
      reason = errorText(error);
  }
  return (
    `Could not save paint layers: ${reason}. Your paint is kept in the editor and retried ` +
    "automatically; don't reload the page until it is saved."
  );
}

// ── Cleanup route ─────────────────────────────────────────────────────────────

/**
 * Reason text for a failed cleanup / stats request.
 * @param error - Caught value (an {@link HttpError} for non-2xx answers).
 * @returns Reason (no prefix).
 */
export function cleanupFailureReason(error: unknown): string {
  const kind = classifyError(error);
  if (kind === "offline") return "the ComfyUI server is unreachable";
  if (kind === "missing") {
    return (
      "the cleanup route is not available; the PainterSketch Python node probably failed to load " +
      "(check the ComfyUI console) or ComfyUI needs a restart after an update"
    );
  }
  if (error instanceof HttpError) {
    if (kind === "server") return `server error (HTTP ${error.status}): ${error.serverMessage ?? "see the ComfyUI console"}`;
    return error.serverMessage ?? error.message;
  }
  return errorText(error);
}

// ── Manifest ──────────────────────────────────────────────────────────────────

/**
 * Toast text for a widget value `parseDocument` rejected. The raw value is
 * kept as the widget value until the user paints (controller), so this
 * says so instead of implying the painting is gone.
 * @param reason - `parseDocument`'s reason.
 * @returns Message.
 */
export function invalidDocumentMessage(reason: string): string {
  const hint = reason.startsWith("unsupported document version")
    ? " It was probably saved by a newer PainterSketch; update the node."
    : "";
  return (
    `Could not read the saved painting (${reason}); showing an empty canvas.${hint} ` +
    "The saved data is kept in the workflow unless you paint on this node."
  );
}

// ── Restore ───────────────────────────────────────────────────────────────────

/** One layer that did not restore cleanly. */
export interface RestoreProblem {
  /** Layer name (shown to the user). */
  name: string;
  /** Failure kind, or `stale`: loaded, but sized for an older canvas. */
  kind: FailureKind | "stale";
}

/** A message for {@link notify}-style display. */
export interface UserMessage {
  severity: "warn" | "error";
  message: string;
}

const MAX_NAMES = 3;

function nameList(problems: readonly RestoreProblem[]): string {
  const names = problems.slice(0, MAX_NAMES).map((p) => `"${p.name}"`);
  const more = problems.length - names.length;
  return more > 0 ? `${names.join(", ")} +${more} more` : names.join(", ");
}

function layers(n: number): string {
  return n === 1 ? "1 layer" : `${n} layers`;
}

/**
 * One message summarizing every restore problem of a document, or `null`.
 *
 * Severity: `error` when a transient failure (server down / server error)
 * left layers empty -- painting on them would replace recoverable content;
 * `warn` otherwise (file gone or corrupt, or a size mismatch).
 *
 * @param problems - Per-layer problems of one restore.
 * @returns The message, or `null` when there were none.
 */
export function restoreSummary(problems: readonly RestoreProblem[]): UserMessage | null {
  if (!problems.length) return null;
  const missing = problems.filter((p) => p.kind === "missing");
  const unreadable = problems.filter((p) => p.kind === "unreadable");
  const stale = problems.filter((p) => p.kind === "stale");
  const transient = problems.filter((p) => !["missing", "unreadable", "stale"].includes(p.kind));
  const parts: string[] = [];
  if (transient.length) {
    const offline = transient.every((p) => p.kind === "offline");
    const reason = offline ? "the ComfyUI server is unreachable" : "server error, see the console";
    parts.push(
      `${layers(transient.length)} could not be loaded (${reason}): ${nameList(transient)}. ` +
        "Reload the workflow to retry before painting on them.",
    );
  }
  if (missing.length) {
    parts.push(
      `${layers(missing.length)} lost ${missing.length === 1 ? "its" : "their"} file ` +
        `(deleted from input/painter-sketch?): ${nameList(missing)}; loaded empty.`,
    );
  }
  if (unreadable.length) {
    parts.push(`${layers(unreadable.length)} could not be decoded (corrupt file?): ${nameList(unreadable)}; loaded empty.`);
  }
  if (missing.length || unreadable.length || transient.length) {
    parts.push("Their saved file references are kept until you edit those layers.");
  }
  if (stale.length) {
    parts.push(
      `${layers(stale.length)} ${stale.length === 1 ? "was" : "were"} saved at an older canvas size ` +
        `(latest edits probably never uploaded): ${nameList(stale)}; check their position.`,
    );
  }
  return { severity: transient.length ? "error" : "warn", message: parts.join(" ") };
}
