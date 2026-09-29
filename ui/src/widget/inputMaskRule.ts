/**
 * Where the Input Mask row (M13b, SPEC "Image Mask / Input Mask") gets its
 * pixels while the node's `mask` input is connected: pure rules plus the
 * executed-preview provenance store. Used by `inputMaskSync.ts`.
 *
 * 1. Our executed output's mask preview (`input_mask` ui key, Python
 *    `nodes/previews.py`; gray value = coverage), when it was produced with
 *    the current `mask` link and the same live source as now: after a run
 *    Python's preview replaces the live read (a changed live file, e.g. a new
 *    LoadImage selection, is read live again until the next run).
 * 2. Live: `mask` comes from a MASK-typed output of any node that shows a
 *    `/view` file (the background lookup) -> `channel=a` of that file
 *    (coverage = 255 - alpha, LoadImage's MASK). Core LoadImageMask counts
 *    only with `channel` = alpha (its other channels are colour planes).
 * 3. Otherwise wait: an empty row with "Run the workflow to load this mask"
 *    (Python still uses the mask).
 *
 * Every choice has a stable key (`mask:` prefix = an Input Mask record's
 * `sourceKey`, `document/imageMask.ts`); pixels are fetched only when it changes.
 */

import { INPUT_MASK_KEY_PREFIX } from "../document/imageMask";
import type { NodeExecutionOutput, ResultItem } from "../types/comfy";
import type { ImageSource } from "./imageSource";
import { withAlphaChannel } from "./viewUrl";

/** UI output key of the mask preview (Python `INPUT_MASK_UI_KEY`). */
export const INPUT_MASK_UI_KEY = "input_mask";

/** Where the row's pixels come from. `url: null` = no mask (Python saw LoadImage's placeholder). */
export type InputMaskChoice =
  | { kind: "preview"; key: string; url: string | null }
  | { kind: "live"; key: string; url: string }
  | { kind: "wait"; key: string };

/** A live (pre-run) source: the `channel=a` read of the image node's file. */
export interface LiveMask {
  key: string;
  url: string;
}

/** A mask preview item of our executed output. */
export type MaskPreviewItem = ResultItem & { mask_id?: string; empty?: boolean };

// ── Provenance ────────────────────────────────────────────────────────────────

/** What a mask preview was produced with. */
export interface MaskProvenance {
  /** `mask` link identity at execution time. */
  link: string;
  /** Live source key at execution time (`null` = none). */
  liveKey: string | null;
}

/** Most provenance entries kept (oldest dropped first). */
const MAX_PROVENANCE = 256;

/** Preview key -> provenance; module-level (survives tab switches / graph undo). */
const provenance = new Map<string, MaskProvenance>();

/**
 * Remember what a mask preview was produced with.
 * @param previewKey - {@link maskPreviewKey} of the preview.
 * @param origin - Its provenance.
 */
export function recordMaskPreview(previewKey: string, origin: MaskProvenance): void {
  provenance.delete(previewKey);
  provenance.set(previewKey, origin);
  while (provenance.size > MAX_PROVENANCE) {
    const oldest = provenance.keys().next().value;
    if (oldest === undefined) break;
    provenance.delete(oldest);
  }
}

/**
 * @param previewKey - {@link maskPreviewKey} of a preview.
 * @returns What it was produced with, or `undefined` when unknown.
 */
export function maskPreviewOrigin(previewKey: string): MaskProvenance | undefined {
  return provenance.get(previewKey);
}

// ── Preview items ─────────────────────────────────────────────────────────────

/**
 * The mask preview item of an executed output, if any.
 * @param output - Our node's `ui` output.
 * @returns First item with a file or the "no mask" marker, else `null`.
 */
export function maskPreviewItem(output: NodeExecutionOutput | null | undefined): MaskPreviewItem | null {
  const items = output?.[INPUT_MASK_UI_KEY];
  if (!Array.isArray(items)) return null;
  for (const item of items as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { filename, empty } = item as MaskPreviewItem;
    if ((typeof filename === "string" && filename) || empty === true) return item as MaskPreviewItem;
  }
  return null;
}

/**
 * Stable key of a mask preview item (its content id; files get random names per run).
 * @param item - Item from {@link maskPreviewItem}.
 * @returns Key.
 */
export function maskPreviewKey(item: MaskPreviewItem): string {
  if (item.empty === true) return `${INPUT_MASK_KEY_PREFIX}preview:none`;
  const id = typeof item.mask_id === "string" && item.mask_id ? item.mask_id : `${item.subfolder ?? ""}/${item.filename ?? ""}`;
  return `${INPUT_MASK_KEY_PREFIX}preview:${id}`;
}

// ── Choice ────────────────────────────────────────────────────────────────────

/** Core "Load Image (as Mask)": its MASK is the file's alpha only with `channel` "alpha". */
export const LOAD_IMAGE_MASK_CLASS = "LoadImageMask";

/** What feeds `mask`, as far as the live rule needs it. */
export interface MaskOrigins {
  /** Real origin node of `mask` (reroutes walked), if resolvable. */
  maskNode: object | null;
  /** Output type of the `mask` origin slot (`"MASK"` for LoadImage's mask). */
  maskSlotType: string | null;
  /** Node class of the `mask` origin (`comfyClass` / `type`), if known. */
  maskClass: string | null;
  /** Its `channel` widget value (only read for {@link LOAD_IMAGE_MASK_CLASS}). */
  maskChannel: unknown;
  /** The `mask` origin's shown source (`imageSource.ts` `sourceFromNode`), if any. */
  source: ImageSource | null;
}

/**
 * Whether a LoadImageMask `channel` value selects alpha (Python takes
 * `channel[0].upper() == "A"`; the combo offers alpha/red/green/blue).
 * @param channel - Widget value.
 * @returns `true` for alpha.
 */
function isAlphaChannel(channel: unknown): boolean {
  return typeof channel === "string" && channel.charAt(0).toUpperCase() === "A";
}

/**
 * The live source, if the rule allows one: the `mask` origin is a MASK-typed
 * slot of any node that shows a `/view` file (a LoadImageMask only with its
 * `channel` on alpha). Coverage = 255 - alpha, like LoadImage's MASK.
 * @param o - Origins.
 * @returns Live source or `null`.
 */
export function liveMaskSource(o: MaskOrigins): LiveMask | null {
  if (!o.maskNode || o.maskSlotType !== "MASK" || !o.source) return null;
  if (o.maskClass === LOAD_IMAGE_MASK_CLASS && !isAlphaChannel(o.maskChannel)) return null;
  const url = withAlphaChannel(o.source.url);
  return url ? { key: `${INPUT_MASK_KEY_PREFIX}live:${o.source.key}`, url } : null;
}

/** Inputs of {@link chooseInputMask}. */
export interface InputMaskCandidates {
  /** Current `mask` link identity. */
  link: string;
  /** {@link liveMaskSource}. */
  live: LiveMask | null;
  /** Our executed mask preview (key + `/view` URL, `null` URL = no mask), if any. */
  preview: { key: string; url: string | null } | null;
  /** Its provenance (`undefined` = unknown: not trusted). */
  previewOrigin: MaskProvenance | undefined;
}

/**
 * Where the row's pixels come from now (module doc for the order).
 * @param c - Candidates.
 * @returns The choice.
 */
export function chooseInputMask(c: InputMaskCandidates): InputMaskChoice {
  const origin = c.previewOrigin;
  if (c.preview && origin && origin.link === c.link && origin.liveKey === (c.live?.key ?? null)) {
    return { kind: "preview", key: c.preview.key, url: c.preview.url };
  }
  if (c.live) return { kind: "live", key: c.live.key, url: c.live.url };
  return { kind: "wait", key: `${INPUT_MASK_KEY_PREFIX}wait:${c.link}` };
}
