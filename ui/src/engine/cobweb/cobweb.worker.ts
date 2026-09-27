/**
 * Cobweb worker entry: grows a {@link CobwebCore} and rasters it into an
 * OffscreenCanvas, posting ImageBitmaps back. Bundled INLINE into the main
 * file (`?worker&inline`, Blob URL at runtime) so `js/` stays one file.
 */

import { CobwebCore } from "./cobwebCore";
import type { FromWorker, ToWorker } from "./cobwebOptions";
import { CobwebRaster } from "./cobwebRaster";

/** The bits of `DedicatedWorkerGlobalScope` used here (DOM lib has no worker types). */
interface WorkerScope {
  postMessage(message: FromWorker, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
}

const scope = self as unknown as WorkerScope;
let core: CobwebCore | null = null;
let raster: CobwebRaster | null = null;
let gen = 0;
let animate = false;
let timer: ReturnType<typeof setTimeout> | undefined;

// ── Send ──────────────────────────────────────────────────────────────────────

function send(): void {
  if (!core || !raster || !(raster.canvas instanceof OffscreenCanvas)) return;
  const bitmap = raster.canvas.transferToImageBitmap();
  // transferToImageBitmap clears the canvas; put it back for later increments.
  const ctx = raster.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bitmap, 0, 0);
  ctx.restore();
  scope.postMessage({ gen, reg: raster.reg, done: core.done, bitmap }, [bitmap]);
}

function loop(): void {
  if (!core) return;
  // Animated: a fixed number of steps per ~frame; otherwise grow to completion.
  const done = animate ? core.growSteps(core.o.stepsPerFrame) : core.grow(Infinity);
  if (animate || done) {
    raster?.drawNew();
    send();
  }
  if (!done) timer = setTimeout(loop, animate ? 16 : 0);
}

// ── Messages ──────────────────────────────────────────────────────────────────

scope.onmessage = (event) => {
  const m = event.data;
  if (m.type === "start") {
    clearTimeout(timer);
    gen = m.gen;
    animate = m.animate;
    core = new CobwebCore(m.opts, m.aspect);
    raster = CobwebRaster.create(core, m.k, m.pr, m.reg);
    loop();
  } else if (m.gen === gen && core) {
    raster = CobwebRaster.create(core, m.k, m.pr, m.reg);
    if (core.done || animate) send();
  }
};
