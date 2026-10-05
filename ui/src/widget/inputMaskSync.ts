/**
 * Input Mask, widget side: while the node's `mask` input is connected
 * this owns the fixed mask row (`Editor.imageMask.setInput`) instead of the
 * image-alpha sync (`imageMaskSync.ts`); the choice of pixels is the pure
 * rule in `inputMaskRule.ts` (live `channel=a` read of the mask node's file,
 * our executed mask preview, or an empty row waiting for a run).
 *
 * - The row is always shown while connected; its settings (eye, colour,
 *   opacity, Subtract) carry over from whatever row was there. It has no file
 *   and never uploads (Python has the tensor).
 * - Pixels are fetched once per choice key + image size per session; a newer
 *   choice discards an older fetch. Coverage is resampled to the image size.
 * - Taking the row over forgets the image-alpha source, so a disconnect reads
 *   the image's alpha again (or removes the row, `imageMaskSync.ts`).
 */

import { api } from "@comfy/scripts/api.js";
import { app } from "@comfy/scripts/app.js";

import type { Size } from "../geometry/rect";
import { coverageFromAlpha, coverageFromGray, resampleCoverage } from "../engine/imageMask";
import { log } from "../log";
import type { LGraphNode, NodeExecutionOutput } from "../types/comfy";
import { INPUT_NAMES } from "./constants";
import { fetchPixels, forgetImageMaskSource } from "./imageMaskSync";
import { chooseInputMask, liveMaskSource, maskPreviewItem, maskPreviewKey, maskPreviewOrigin, recordMaskPreview } from "./inputMaskRule";
import type { InputMaskChoice, LiveMask, MaskPreviewItem } from "./inputMaskRule";
import { findUpstreamOutput, inputSlotIndex, nodeLocatorId, sourceFromNode } from "./imageSource";
import type { EditorSession } from "./sessions";
import { viewUrl } from "./viewUrl";

/** Choice key + size applied (or being fetched) per session. */
const applied = new WeakMap<EditorSession, string>();

/**
 * Input Mask feeding for one node instance.
 */
export class InputMaskWatch {
  private executed: NodeExecutionOutput | null = null;

  /**
   * @param node - Our node.
   */
  constructor(private readonly node: LGraphNode) {}

  /**
   * Our node executed: remember its mask preview and what it was made with
   * (the current `mask` link and live source).
   * @param output - Execution output.
   */
  setExecuted(output: NodeExecutionOutput): void {
    this.executed = output;
    const item = maskPreviewItem(output);
    const link = this.maskLink();
    if (item && link) recordMaskPreview(maskPreviewKey(item), { link, liveKey: this.live()?.key ?? null });
  }

  /**
   * Apply the Input Mask rule while `mask` is connected (cheap when nothing changed).
   * @param session - Attached session.
   * @param imageSize - Size of the shown image (else the editor's image size is used).
   * @param settled - Startup is over (upstream widgets are configured).
   * @returns `false` while `mask` is disconnected (the image-alpha rule owns the row).
   */
  sync(session: EditorSession, imageSize: Size | null, settled: boolean): boolean {
    const link = this.maskLink();
    if (!link) {
      applied.delete(session);
      return false;
    }
    if (!settled || !session.alive) return true;
    const editor = session.editor;
    const choice = chooseInputMask({ link, live: this.live(), ...this.preview() });
    const size = imageSize ?? editor.imageSize;
    const token = `${choice.key}|${size.width}x${size.height}`;
    if (applied.get(session) === token && editor.imageMask.isInput) return true;
    applied.set(session, token);
    if (!editor.imageMask.isInput) forgetImageMaskSource(session);
    const url = choice.kind === "wait" ? null : choice.url;
    if (!url) {
      editor.imageMask.setInput(choice.key, size, null, choice.kind === "wait");
      return true;
    }
    // The row shows at once; its pixels follow (an Input Mask row keeps its old ones meanwhile).
    if (!editor.imageMask.isInput) editor.imageMask.setInput(choice.key, size, null, false);
    void load(session, choice, url, size, token);
    return true;
  }

  /** Identity of the `mask` link, or `null` when unlinked. */
  private maskLink(): string | null {
    const slot = inputSlotIndex(this.node, INPUT_NAMES.mask);
    return slot >= 0 && this.node.inputs[slot]?.link != null ? (findUpstreamOutput(this.node, slot)?.link ?? null) : null;
  }

  /** The live source (MASK slot of a node showing a `/view` file), if any. */
  private live(): LiveMask | null {
    const maskOut = findUpstreamOutput(this.node, inputSlotIndex(this.node, INPUT_NAMES.mask));
    const maskNode = maskOut?.node ?? null;
    if (!maskNode || !maskOut) return null;
    return liveMaskSource({
      maskNode,
      maskSlotType: maskNode.outputs?.[maskOut.slot]?.type ?? null,
      maskClass: maskNode.comfyClass ?? maskNode.type ?? null,
      maskChannel: maskNode.widgets?.find((w) => w.name === "channel")?.value,
      source: sourceFromNode(maskNode),
    });
  }

  /** Our executed mask preview (this session's output, else `app.nodeOutputs`). */
  private preview(): { preview: { key: string; url: string | null } | null; previewOrigin: ReturnType<typeof maskPreviewOrigin> } {
    const locator = nodeLocatorId(this.node);
    const item: MaskPreviewItem | null = maskPreviewItem(this.executed) ?? maskPreviewItem(locator ? app.nodeOutputs[locator] : null);
    if (!item) return { preview: null, previewOrigin: undefined };
    const key = maskPreviewKey(item);
    const url = item.empty === true ? null : viewUrl(item, (route) => api.apiURL(route), app.getRandParam());
    return { preview: { key, url }, previewOrigin: maskPreviewOrigin(key) };
  }
}

/** Fetch one choice's pixels and apply them unless a newer choice took over. */
async function load(session: EditorSession, choice: InputMaskChoice, url: string, size: Size, token: string): Promise<void> {
  let coverage: Uint8Array | null = null;
  try {
    const pixels = await fetchPixels(url);
    // Live: 255 - alpha (an opaque file is an empty mask, not "no row"); preview: gray = coverage.
    const plane = choice.kind === "live" ? (coverageFromAlpha(pixels.data) ?? new Uint8Array(pixels.width * pixels.height)) : coverageFromGray(pixels.data);
    coverage = resampleCoverage(plane, { width: pixels.width, height: pixels.height }, size);
  } catch (error) {
    log.warn("Could not load the mask input:", url, error);
  }
  if (!session.alive || applied.get(session) !== token) return;
  // A failed read waits for a run (Python still has the mask).
  session.editor.imageMask.setInput(choice.key, size, coverage, coverage === null);
}
