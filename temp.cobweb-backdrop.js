// cobweb-backdrop.js
// Organic, mycelium-like mesh that grows out from the edges of an image rect,
// with webbing draped across the acute forks. Fills the empty canvas around
// the document in an editor.
//
// Usage:
//   import { CobwebBackdrop } from './cobweb-backdrop.js';
//   const web = new CobwebBackdrop({ onUpdate: () => requestRedraw() });
//   // in your render, before drawing the image:
//   web.draw(ctx, { x, y, w, h });   // image rect in ctx's current units
//
// Cost on the main thread is one drawImage of the visible area per frame.
//   - Growth and rasterizing run in a Web Worker (this same file) when
//     Worker + OffscreenCanvas exist; otherwise they run on the main thread
//     in small per-frame slices.
//   - Geometry is grown once per image aspect ratio, in the image's own
//     space, so the web stays attached to the image when you pan and zoom.
//   - Only the visible area (plus panPad) is rastered, at screen resolution.
//     Zooming stretches the current bitmap at once and a sharp one arrives
//     after the zoom settles; panning past the padded area restrokes too.
//     Neither regrows.

const DEFAULTS = {
  color: [88, 80, 112],          // strand color at the image edge
  drapeColor: [120, 110, 156],   // webbing color
  genSize: 600,                  // long side of the image in generation units
  margin: 700,                   // how far strands can reach past the image edge (gen units)
  seedSpacing: 7,                // gen units between starting strands along the edge
  step: 1.7,
  join: 5.5,                     // fuse distance
  branch: 0.052,                 // chance per step that a strand forks
  maxNodes: 70000,
  maxTips: 1400,
  lineWidth: [1.3, 0.5],         // screen px at the edge, at full distance
  drape: {
    maxAngle: 90,                // degrees; wider forks get no webbing
    length: 20,                  // steps along each arm
    start: 0.12,                 // fraction of margin before drapes begin
    ramp: 0.30,                  // fraction of margin to reach full strength
  },
  seed: 1,
  animate: true,                 // show it growing; false = appear when finished
  worker: true,                  // false forces main-thread mode
  budgetMs: 6,                   // main-thread mode: growth time per frame
  rasterDelayMs: 120,            // wait after a zoom before restroking
  maxBitmapPixels: 16e6,         // safety cap; bitmap drops resolution beyond this
  panPad: 0.5,                   // extra rastered area around the view, as a fraction of it
  onUpdate: null,                // called when the host should redraw
};

const NB = 24;   // brightness buckets for batched stroking
const CELL = 8;  // spatial hash cell size

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
const makeCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
};
const mergeOpts = (base, o = {}) => ({ ...base, ...o, drape: { ...base.drape, ...(o.drape || {}) } });

// ------------------------------------------------------------------ core
// Pure growth + rasterizing. No scheduling; runs in the worker or main thread.

class CobwebCore {
  constructor(o, aspect) {
    this.o = o;
    this.rand = mulberry32(o.seed);
    this.gw = aspect >= 1 ? o.genSize : o.genSize * aspect;
    this.gh = aspect >= 1 ? o.genSize / aspect : o.genSize;
    this.nodes = 0; this.grid = new Map(); this.tips = []; this.tipId = 0;
    this.segs = Array.from({ length: NB }, () => []);
    this.drapes = [];
    this.bmp = null;
    this.done = false;

    const R = this.rand, W = this.gw, H = this.gh;
    const per = 2 * (W + H), count = Math.round(per / o.seedSpacing);
    for (let i = 0; i < count; i++) {
      let t = (i + R() * 0.8) / count * per, x, y, a;
      if (t < W) { x = t; y = 0; a = -Math.PI / 2; }
      else if ((t -= W) < H) { x = W; y = t; a = 0; }
      else if ((t -= H) < W) { x = W - t; y = H; a = Math.PI / 2; }
      else { t -= W; x = 0; y = H - t; a = Math.PI; }
      const n = this._addNode(x, y, 0);
      this.tips.push({ id: ++this.tipId, parent: -1, x, y, a: a + (R() - 0.5) * 1.2,
                       drift: (R() - 0.5) * 0.04, last: n, age: 0, feeds: [] });
    }
  }

  /** Grow for up to ms milliseconds (Infinity = to completion). Returns done. */
  grow(ms) {
    const t0 = performance.now();
    while (this.tips.length && this.nodes < this.o.maxNodes) {
      this._step();
      if (performance.now() - t0 >= ms) break;
    }
    this.done = !(this.tips.length && this.nodes < this.o.maxNodes);
    return this.done;
  }

  _addNode(x, y, owner) {
    const n = { x, y, owner };
    this.nodes++;
    const k = ((x / CELL) | 0) + ',' + ((y / CELL) | 0);
    let cell = this.grid.get(k);
    if (!cell) this.grid.set(k, (cell = []));
    cell.push(n);
    return n;
  }

  _near(x, y, tip) {
    const gx = (x / CELL) | 0, gy = (y / CELL) | 0, J = this.o.join;
    let best = null, bd = J * J;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cell = this.grid.get((gx + i) + ',' + (gy + j));
      if (!cell) continue;
      for (const n of cell) {
        if (n.owner <= 0 || n.owner === tip.id || n.owner === tip.parent) continue;
        const d = (n.x - x) ** 2 + (n.y - y) ** 2;
        if (d < bd) { bd = d; best = n; }
      }
    }
    return best;
  }

  _dist(x, y) {
    const dx = Math.max(-x, 0, x - this.gw), dy = Math.max(-y, 0, y - this.gh);
    return Math.hypot(dx, dy);
  }

  _seg(a, b, d) {
    const i = Math.min(NB - 1, (d / this.o.margin * NB) | 0);
    this.segs[i].push(a.x, a.y, b.x, b.y);
  }

  _drapeWeight(d) {
    const { start, ramp } = this.o.drape, M = this.o.margin;
    return Math.max(0, Math.min(1, (d - M * start) / (M * ramp)));
  }

  _endSide(f) {
    if (++f.ends < 2) return;
    const n = Math.min(f.a.length, f.b.length);
    if (n < 4) return;
    const o = f.o, A = f.a[n - 1], B = f.b[n - 1];
    const ang = Math.abs(wrapA(Math.atan2(A.y - o.y, A.x - o.x) - Math.atan2(B.y - o.y, B.x - o.x)));
    if (ang > this.o.drape.maxAngle * Math.PI / 180) return;
    const w = this._drapeWeight(this._dist(o.x, o.y));
    const R = this.rand;
    if (w <= 0 || R() > w) return;
    const diag = [];
    for (let i = 0; i < n; i++) diag.push(R() < 0.5);
    this.drapes.push({ o, a: f.a.slice(0, n), b: f.b.slice(0, n), alpha: 0.35 + 0.65 * w,
                       sag: 0.18 + R() * 0.22, diag });
  }

  _kill(t) { for (const f of t.feeds) this._endSide(f[0]); t.feeds = []; }

  _step() {
    const o = this.o, R = this.rand, M = o.margin;
    const cx = this.gw / 2, cy = this.gh / 2, next = [];
    for (const t of this.tips) {
      // wander, with a gentle pull away from the image
      const out = Math.atan2(t.y - cy, t.x - cx);
      t.a += (R() - 0.5) * 0.45 + t.drift + wrapA(out - t.a) * 0.015;
      const x = t.x + Math.cos(t.a) * o.step, y = t.y + Math.sin(t.a) * o.step;
      const inside = x > 0 && x < this.gw && y > 0 && y < this.gh;
      if (inside || x < -M || y < -M || x > this.gw + M || y > this.gh + M) { this._kill(t); continue; }
      const d = this._dist(x, y);

      t.age++;
      const hit = t.age > 14 ? this._near(x, y, t) : null;
      if (hit) {
        this._seg(t.last, hit, d);                       // fuse into the mesh
        if (R() < 0.45) { this._kill(t); continue; }
      }
      const n = this._addNode(x, y, t.id);
      this._seg(t.last, n, d);
      t.x = x; t.y = y; t.last = n;
      t.feeds = t.feeds.filter(([f, side]) => {
        f[side].push(n);
        if (f[side].length >= f.L) { this._endSide(f); return false; }
        return true;
      });

      if (R() < 0.0015 + (d / M) * 0.012) { this._kill(t); continue; }   // thins with distance
      next.push(t);
      if (R() < o.branch) {
        const s = R() < 0.5 ? -1 : 1;
        const L = Math.max(4, Math.round(o.drape.length * (0.5 + R()) * (1 + 0.8 * this._drapeWeight(d))));
        const f = { o: n, a: [], b: [], ends: 0, L };
        t.feeds.push([f, 'a']);
        next.push({ id: ++this.tipId, parent: t.id, x, y, a: t.a + s * (0.35 + R() * 0.7),
                    drift: (R() - 0.5) * 0.04, last: n, age: 0, feeds: [[f, 'b']] });
      }
    }
    if (next.length > o.maxTips) {
      for (let i = next.length - 1; i > 0; i--) { const j = (R() * (i + 1)) | 0; [next[i], next[j]] = [next[j], next[i]]; }
      next.slice(o.maxTips).forEach(t => this._kill(t));
      next.length = o.maxTips;
    }
    this.tips = next;
  }

  /**
   * New bitmap at zoom k (screen units per gen unit) and pixel ratio pr,
   * covering reg {x0,y0,x1,y1} in gen units.
   */
  raster(k, pr, reg) {
    let W = (reg.x1 - reg.x0) * k * pr, H = (reg.y1 - reg.y0) * k * pr;
    const es = Math.min(1, Math.sqrt(this.o.maxBitmapPixels / (W * H)));
    W = Math.max(1, Math.ceil(W * es)); H = Math.max(1, Math.ceil(H * es));
    const canvas = makeCanvas(W, H), ctx = canvas.getContext('2d');
    const s = k * pr * es;
    ctx.setTransform(s, 0, 0, s, -reg.x0 * s, -reg.y0 * s);
    ctx.lineCap = 'round';
    this.bmp = { canvas, ctx, k, pr, reg, px: 1 / k, drawnSegs: new Array(NB).fill(0), drawnDrapes: 0 };
    this.rasterNew();
  }

  /** Draw whatever has grown since the last raster call. */
  rasterNew() {
    const bmp = this.bmp, ctx = bmp.ctx;
    if (bmp.drawnDrapes < this.drapes.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';   // webbing sits behind strands
      for (let i = bmp.drawnDrapes; i < this.drapes.length; i++) this._drawDrape(ctx, this.drapes[i], bmp.px);
      ctx.restore();
      bmp.drawnDrapes = this.drapes.length;
    }
    const [c0, c1, c2] = this.o.color, [lw0, lw1] = this.o.lineWidth;
    for (let b = 0; b < NB; b++) {
      const arr = this.segs[b], from = bmp.drawnSegs[b];
      if (from >= arr.length) continue;
      const p = new Path2D();
      for (let i = from; i < arr.length; i += 4) { p.moveTo(arr[i], arr[i + 1]); p.lineTo(arr[i + 2], arr[i + 3]); }
      const t = (b + 0.5) / NB;
      ctx.strokeStyle = `rgba(${c0},${c1},${c2},${0.85 * (1 - t) ** 1.4 + 0.06})`;
      ctx.lineWidth = (lw0 + (lw1 - lw0) * t) * bmp.px;
      ctx.stroke(p);
      bmp.drawnSegs[b] = arr.length;
    }
  }

  _drawDrape(ctx, d, px) {
    const { o, a, b, alpha, sag, diag } = d, n = a.length;
    const [r, g, bl] = this.o.drapeColor, col = x => `rgba(${r},${g},${bl},${x})`;
    const A = a[n - 1], B = b[n - 1];
    const across = (p, q, k) => {          // control point pulled back toward the fork
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      return [mx + (o.x - mx) * k, my + (o.y - my) * k];
    };
    const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, Math.hypot(A.x - o.x, A.y - o.y) + 1);
    grad.addColorStop(0, col(0.42 * alpha));
    grad.addColorStop(1, col(0.08 * alpha));
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.moveTo(o.x, o.y);
    for (let i = 0; i < n; i++) ctx.lineTo(a[i].x, a[i].y);
    const [qx, qy] = across(A, B, sag);
    ctx.quadraticCurveTo(qx, qy, B.x, B.y);
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(b[i].x, b[i].y);
    ctx.closePath(); ctx.fill();

    ctx.lineWidth = 0.55 * px;
    for (let i = 1; i < n; i += 1 + ((i / 6) | 0)) {
      const p = a[i], q = b[i], k = sag * (i / n);
      const [cx, cy] = across(p, q, k);
      ctx.strokeStyle = col(alpha * (0.95 - 0.45 * i / n));
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.quadraticCurveTo(cx, cy, q.x, q.y); ctx.stroke();
      if (i + 3 < n && diag[i]) {
        const q2 = b[i + 3], [dx, dy] = across(p, q2, k);
        ctx.strokeStyle = col(alpha * 0.5);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.quadraticCurveTo(dx, dy, q2.x, q2.y); ctx.stroke();
      }
    }
  }
}

// ------------------------------------------------------------------ public

export class CobwebBackdrop {
  constructor(options = {}) {
    this.o = mergeOpts(DEFAULTS, options);
    this.aspect = null;
    this.img = null; this.imgReg = null; // latest bitmap and the gen-unit region it covers
    this.gen = 0; this.want = null;      // view we last asked for
    this._done = false;
    this._timer = 0; this._raf = 0;
    this.worker = null;
    if (this.o.worker && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      try {
        this.worker = new Worker(import.meta.url, { type: 'module' });
        this.worker.onmessage = e => this._receive(e.data);
        this.worker.onerror = () => { this.worker?.terminate(); this.worker = null; this._restart(); };
      } catch { this.worker = null; }
    }
  }

  /** True once growth has finished. */
  get done() { return this._done; }

  /** Change options; anything besides onUpdate regrows. */
  setOptions(options = {}) {
    this.o = mergeOpts(this.o, options);
    this._restart();
  }

  /** Regrow with a new seed (random if omitted). */
  reseed(seed = (Math.random() * 2 ** 31) | 0) { this.setOptions({ seed }); }

  destroy() {
    clearTimeout(this._timer); cancelAnimationFrame(this._raf);
    this.worker?.terminate(); this.worker = null;
    this.img?.close?.(); this.img = null; this.core = null;
  }

  /**
   * Draw the web behind the image. rect is the image rect in ctx units.
   * pixelRatio is device pixels per ctx unit. viewport (ctx units) limits the
   * blit to what's visible; it defaults to the whole canvas.
   */
  draw(ctx, rect, pixelRatio = globalThis.devicePixelRatio || 1, viewport) {
    if (!(rect.w > 0 && rect.h > 0)) return;
    const aspect = rect.w / rect.h, M = this.o.margin;
    const gw = aspect >= 1 ? this.o.genSize : this.o.genSize * aspect, gh = gw / aspect;
    const k = rect.w / gw;

    // Visible part of the web, in gen units
    const vp = viewport || { x: 0, y: 0, w: ctx.canvas.width / pixelRatio, h: ctx.canvas.height / pixelRatio };
    const vis = {
      x0: Math.max(-M, (vp.x - rect.x) / k), y0: Math.max(-M, (vp.y - rect.y) / k),
      x1: Math.min(gw + M, (vp.x + vp.w - rect.x) / k), y1: Math.min(gh + M, (vp.y + vp.h - rect.y) / k),
    };
    if (vis.x1 <= vis.x0 || vis.y1 <= vis.y0) return;
    const padded = () => {
      const px = (vis.x1 - vis.x0) * this.o.panPad, py = (vis.y1 - vis.y0) * this.o.panPad;
      return { x0: Math.max(-M, vis.x0 - px), y0: Math.max(-M, vis.y0 - py),
               x1: Math.min(gw + M, vis.x1 + px), y1: Math.min(gh + M, vis.y1 + py) };
    };

    if (this.aspect === null || Math.abs(aspect / this.aspect - 1) > 1e-3) {
      this.aspect = aspect;
      this.want = { k, pr: pixelRatio, reg: padded() };
      this._restart();
    } else {
      const w = this.want, zoomed = Math.abs(k / w.k - 1) > 0.01 || pixelRatio !== w.pr;
      const covered = vis.x0 >= w.reg.x0 && vis.y0 >= w.reg.y0 && vis.x1 <= w.reg.x1 && vis.y1 <= w.reg.y1;
      if (zoomed || !covered) {
        this.want = { k, pr: pixelRatio, reg: padded() };
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this._view(), zoomed ? this.o.rasterDelayMs : 16);
      }
    }
    if (!this.img) return;

    // Blit the bitmap's region, clipped to the viewport
    const r = this.imgReg;
    const dx = rect.x + r.x0 * k, dy = rect.y + r.y0 * k;
    const dw = (r.x1 - r.x0) * k, dh = (r.y1 - r.y0) * k;
    const x0 = Math.max(dx, vp.x), y0 = Math.max(dy, vp.y);
    const x1 = Math.min(dx + dw, vp.x + vp.w), y1 = Math.min(dy + dh, vp.y + vp.h);
    if (x1 <= x0 || y1 <= y0) return;
    const sx = this.img.width / dw, sy = this.img.height / dh;
    ctx.drawImage(this.img, (x0 - dx) * sx, (y0 - dy) * sy, (x1 - x0) * sx, (y1 - y0) * sy,
                  x0, y0, x1 - x0, y1 - y0);
  }

  _restart() {
    if (this.aspect === null) return;
    const gen = ++this.gen;
    clearTimeout(this._timer); cancelAnimationFrame(this._raf);
    this.img?.close?.(); this.img = null; this._done = false;
    const { onUpdate, ...plain } = this.o;
    if (this.worker) {
      this.worker.postMessage({ type: 'start', gen, opts: plain, aspect: this.aspect, ...this.want });
      return;
    }
    // Main-thread fallback: grow in slices per frame
    const core = this.core = new CobwebCore(this.o, this.aspect);
    core.raster(this.want.k, this.want.pr, this.want.reg);
    const tick = () => {
      if (gen !== this.gen) return;
      const done = core.grow(this.o.animate ? this.o.budgetMs : this.o.budgetMs * 2);
      if (this.o.animate || done) { core.rasterNew(); this.img = core.bmp.canvas; this.imgReg = core.bmp.reg; }
      this._done = done;
      if (this.o.animate || done) this.o.onUpdate?.();
      if (!done) this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _view() {
    const { k, pr, reg } = this.want;
    if (this.worker) { this.worker.postMessage({ type: 'view', gen: this.gen, k, pr, reg }); return; }
    if (!this.core) return;
    this.core.raster(k, pr, reg);
    if (this.core.done || this.o.animate) { this.img = this.core.bmp.canvas; this.imgReg = reg; this.o.onUpdate?.(); }
  }

  _receive(m) {
    if (m.gen !== this.gen) { m.bitmap.close(); return; }
    this.img?.close?.();
    this.img = m.bitmap; this.imgReg = m.reg; this._done = m.done;
    this.o.onUpdate?.();
  }
}

// ------------------------------------------------------------------ worker
// When this file is loaded as a module worker, it serves CobwebBackdrop.

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  let core = null, gen = 0, timer = 0;
  const send = () => {
    const bitmap = core.bmp.canvas.transferToImageBitmap();
    // transferToImageBitmap clears the canvas; put it back for later increments
    core.bmp.ctx.save(); core.bmp.ctx.setTransform(1, 0, 0, 1, 0, 0);
    core.bmp.ctx.drawImage(bitmap, 0, 0); core.bmp.ctx.restore();
    self.postMessage({ gen, reg: core.bmp.reg, done: core.done, bitmap }, [bitmap]);
  };
  const loop = () => {
    const animate = core.o.animate;
    const done = core.grow(animate ? 60 : Infinity);
    if (animate || done) { core.rasterNew(); send(); }
    if (!done) timer = setTimeout(loop, 0);
  };
  self.onmessage = e => {
    const m = e.data;
    if (m.type === 'start') {
      clearTimeout(timer);
      gen = m.gen;
      core = new CobwebCore(mergeOpts(DEFAULTS, m.opts), m.aspect);
      core.raster(m.k, m.pr, m.reg);
      loop();
    } else if (m.type === 'view' && m.gen === gen && core) {
      core.raster(m.k, m.pr, m.reg);
      if (core.done || core.o.animate) send();
    }
  };
}
