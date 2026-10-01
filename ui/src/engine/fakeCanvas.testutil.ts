/**
 * Test-only canvas fakes (the test environment has no canvas): canvases that
 * store real RGBA bytes, enough for the float / transform paths. Same fakes
 * as `transformOps.test.ts`; import from tests only.
 */

/** `ImageData` stand-in: (data, w, h?) or (w, h), like the DOM constructor. */
export class FakeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  constructor(a: Uint8ClampedArray | number, b: number, c?: number) {
    if (typeof a === "number") {
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    } else {
      this.width = b;
      this.height = c ?? a.length / 4 / b;
      this.data = a;
    }
  }
}

/** 2D context stand-in over {@link FakeCanvas} bytes. */
export class FakeContext {
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  imageSmoothingEnabled = true;
  imageSmoothingQuality = "low";
  constructor(readonly canvas: FakeCanvas) {}
  save(): void {}
  restore(): void {}
  setTransform(): void {}
  beginPath(): void {}
  rect(): void {}
  clip(): void {}
  fillRect(): void {}
  clearRect(x: number, y: number, w: number, h: number): void {
    const c = this.canvas;
    for (let yy = Math.max(0, y); yy < Math.min(c.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(c.width, x + w); xx++) c.px.fill(0, (yy * c.width + xx) * 4, (yy * c.width + xx) * 4 + 4);
    }
  }
  getImageData(x: number, y: number, w: number, h: number): FakeImageData {
    const c = this.canvas;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const sx = x + xx;
        const sy = y + yy;
        if (sx < 0 || sy < 0 || sx >= c.width || sy >= c.height) continue;
        out.set(c.px.subarray((sy * c.width + sx) * 4, (sy * c.width + sx) * 4 + 4), (yy * w + xx) * 4);
      }
    }
    return new FakeImageData(out, w, h);
  }
  putImageData(img: FakeImageData, x: number, y: number): void {
    const c = this.canvas;
    for (let yy = 0; yy < img.height; yy++) {
      for (let xx = 0; xx < img.width; xx++) {
        const dx = x + xx;
        const dy = y + yy;
        if (dx < 0 || dy < 0 || dx >= c.width || dy >= c.height) continue;
        c.px.set(img.data.subarray((yy * img.width + xx) * 4, (yy * img.width + xx) * 4 + 4), (dy * c.width + dx) * 4);
      }
    }
  }
  createImageData(w: number, h: number): FakeImageData {
    return new FakeImageData(new Uint8ClampedArray(w * h * 4), w, h);
  }
  /** `(src, dx, dy)` only: copies non-transparent pixels. */
  drawImage(src: FakeCanvas, dx = 0, dy = 0): void {
    const img = src.ctx.getImageData(0, 0, src.width, src.height);
    const c = this.canvas;
    for (let yy = 0; yy < img.height; yy++) {
      for (let xx = 0; xx < img.width; xx++) {
        const s = (yy * img.width + xx) * 4;
        if (img.data[s + 3] === 0) continue;
        const tx = dx + xx;
        const ty = dy + yy;
        if (tx < 0 || ty < 0 || tx >= c.width || ty >= c.height) continue;
        c.px.set(img.data.subarray(s, s + 4), (ty * c.width + tx) * 4);
      }
    }
  }
}

/** Canvas stand-in holding RGBA bytes. */
export class FakeCanvas {
  private w = 300;
  private h = 150;
  px = new Uint8ClampedArray(300 * 150 * 4);
  readonly ctx: FakeContext = new FakeContext(this);
  get width(): number { return this.w; }
  set width(v: number) { this.w = v; this.px = new Uint8ClampedArray(this.w * this.h * 4); }
  get height(): number { return this.h; }
  set height(v: number) { this.h = v; this.px = new Uint8ClampedArray(this.w * this.h * 4); }
  getContext(): FakeContext { return this.ctx; }
}

/** Install the fakes as `document.createElement` / `ImageData`. */
export function installCanvasFakes(): void {
  (globalThis as { document?: unknown }).document = { createElement: () => new FakeCanvas() };
  (globalThis as { ImageData?: unknown }).ImageData = FakeImageData;
}

// ── Compositing fake (layer masks) ────────────────────────────────────────────

type BlendState = { alpha: number; op: string; fill: string; tx: number; ty: number };

/**
 * 2D context stand-in that really composites straight-alpha RGBA: source-over,
 * destination-out, destination-in, difference, lighter; `globalAlpha`; save/restore;
 * `fillRect` with `#rgb` / `#rrggbb`; `drawImage` 3 / 5 / 9 args (no scaling;
 * composite ops apply inside the destination rect only, i.e. as if clipped
 * to it -- the engine always clips around them). Paths: `fill()` fills the
 * last `rect()` (through `translate`, whole px); other path ops and `stroke()`
 * draw nothing (enough for filled rectangle shapes).
 */
export class BlendContext {
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  fillStyle = "#000000";
  imageSmoothingEnabled = true;
  imageSmoothingQuality = "low";
  private stack: BlendState[] = [];
  private tx = 0;
  private ty = 0;
  private lastRect: [number, number, number, number] | null = null;
  constructor(readonly canvas: BlendCanvas) {}
  save(): void {
    this.stack.push({ alpha: this.globalAlpha, op: this.globalCompositeOperation, fill: this.fillStyle, tx: this.tx, ty: this.ty });
  }
  restore(): void {
    const s = this.stack.pop();
    if (!s) return;
    this.globalAlpha = s.alpha;
    this.globalCompositeOperation = s.op;
    this.fillStyle = s.fill;
    this.tx = s.tx;
    this.ty = s.ty;
  }
  setTransform(): void {}
  translate(x: number, y: number): void {
    this.tx += x;
    this.ty += y;
  }
  beginPath(): void {
    this.lastRect = null;
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.lastRect = [x, y, w, h];
  }
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  ellipse(): void {}
  stroke(): void {}
  fill(): void {
    const r = this.lastRect;
    if (r) this.fillRect(Math.round(r[0] + this.tx), Math.round(r[1] + this.ty), Math.round(r[2]), Math.round(r[3]));
  }
  clip(): void {}
  clearRect(x: number, y: number, w: number, h: number): void {
    this.each(x, y, w, h, (i) => this.canvas.px.fill(0, i, i + 4));
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    const rgb = parseHex(this.fillStyle);
    this.each(x, y, w, h, (i) => this.blend(i, rgb[0], rgb[1], rgb[2], 255));
  }
  getImageData(x: number, y: number, w: number, h: number): FakeImageData {
    const c = this.canvas;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const sx = x + xx;
        const sy = y + yy;
        if (sx >= 0 && sy >= 0 && sx < c.width && sy < c.height) out.set(c.px.subarray((sy * c.width + sx) * 4, (sy * c.width + sx) * 4 + 4), (yy * w + xx) * 4);
      }
    }
    return new FakeImageData(out, w, h);
  }
  putImageData(img: FakeImageData, x: number, y: number): void {
    const c = this.canvas;
    for (let yy = 0; yy < img.height; yy++) {
      for (let xx = 0; xx < img.width; xx++) {
        const dx = x + xx;
        const dy = y + yy;
        if (dx >= 0 && dy >= 0 && dx < c.width && dy < c.height) c.px.set(img.data.subarray((yy * img.width + xx) * 4, (yy * img.width + xx) * 4 + 4), (dy * c.width + dx) * 4);
      }
    }
  }
  createImageData(w: number, h: number): FakeImageData {
    return new FakeImageData(w, h);
  }
  drawImage(src: BlendCanvas, ...args: number[]): void {
    let sx = 0;
    let sy = 0;
    let w = src.width;
    let h = src.height;
    let dx = args[0] ?? 0;
    let dy = args[1] ?? 0;
    if (args.length === 8) {
      [sx, sy, w, h, dx, dy] = args as [number, number, number, number, number, number];
    }
    const c = this.canvas;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const tx = Math.round(dx + xx);
        const ty = Math.round(dy + yy);
        const px = Math.round(sx + xx);
        const py = Math.round(sy + yy);
        if (tx < 0 || ty < 0 || tx >= c.width || ty >= c.height) continue;
        const inSrc = px >= 0 && py >= 0 && px < src.width && py < src.height;
        const s = inSrc ? (py * src.width + px) * 4 : -1;
        const p = src.px;
        this.blend((ty * c.width + tx) * 4, s < 0 ? 0 : (p[s] as number), s < 0 ? 0 : (p[s + 1] as number), s < 0 ? 0 : (p[s + 2] as number), s < 0 ? 0 : (p[s + 3] as number));
      }
    }
  }
  private each(x: number, y: number, w: number, h: number, fn: (i: number) => void): void {
    const c = this.canvas;
    for (let yy = Math.max(0, y); yy < Math.min(c.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(c.width, x + w); xx++) fn((yy * c.width + xx) * 4);
    }
  }
  private blend(i: number, r: number, g: number, b: number, a255: number): void {
    const d = this.canvas.px;
    const sa = (a255 / 255) * this.globalAlpha;
    const da = (d[i + 3] as number) / 255;
    const op = this.globalCompositeOperation;
    if (op === "destination-out") {
      d[i + 3] = Math.round(da * (1 - sa) * 255);
      return;
    }
    if (op === "destination-in") {
      d[i + 3] = Math.round(da * sa * 255);
      return;
    }
    if (op === "lighter") {
      // Premultiplied sum, clamped.
      const la = Math.min(1, sa + da);
      for (let c = 0; c < 3; c++) {
        const v = [r, g, b][c] as number;
        d[i + c] = la === 0 ? 0 : Math.min(255, Math.round((v * sa + (d[i + c] as number) * da) / la));
      }
      d[i + 3] = Math.round(la * 255);
      return;
    }
    const oa = sa + da * (1 - sa);
    const mix = (s: number, dv: number): number => {
      const src = op === "difference" ? Math.abs(s - dv) : s;
      return oa === 0 ? 0 : Math.round((src * sa + dv * da * (1 - sa)) / oa);
    };
    d[i] = mix(r, d[i] as number);
    d[i + 1] = mix(g, d[i + 1] as number);
    d[i + 2] = mix(b, d[i + 2] as number);
    d[i + 3] = Math.round(oa * 255);
  }
}

/** Canvas stand-in for {@link BlendContext}. */
export class BlendCanvas {
  private w = 300;
  private h = 150;
  px = new Uint8ClampedArray(300 * 150 * 4);
  readonly ctx: BlendContext = new BlendContext(this);
  get width(): number { return this.w; }
  set width(v: number) { this.w = v; this.px = new Uint8ClampedArray(this.w * this.h * 4); }
  get height(): number { return this.h; }
  set height(v: number) { this.h = v; this.px = new Uint8ClampedArray(this.w * this.h * 4); }
  getContext(): BlendContext { return this.ctx; }
}

function parseHex(color: string): [number, number, number] {
  let s = color.replace("#", "");
  if (s.length === 3) s = [...s].map((c) => c + c).join("");
  const n = Number.parseInt(s.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Install the compositing fakes as `document.createElement` / `ImageData`. */
export function installBlendCanvasFakes(): void {
  (globalThis as { document?: unknown }).document = { createElement: () => new BlendCanvas() };
  (globalThis as { ImageData?: unknown }).ImageData = FakeImageData;
}

/** Remove what {@link installCanvasFakes} installed. */
export function removeCanvasFakes(): void {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { ImageData?: unknown }).ImageData;
}
