/**
 * NOKIA 3310 WEATHER RETRO — LCD renderer.
 *
 * A virtual 104x64 1-bit framebuffer (like the original 3310 display)
 * drawn with a 5x7 bitmap font and 16x16 pixel icons. Every rAF frame:
 *
 *   1. Compose a 104x64 ImageData (ON #0f380f / OFF #9bbc0f->#8bac0f gradient)
 *   2. Nearest-neighbour upscale to the visible canvas (imageSmoothing OFF)
 *   3. LCD pixel-lattice grid overlay (#306230, low alpha)
 *   4. Subtle animated dither grain (4 rotating noise tiles, 120 ms step)
 *   5. Vignette (edge darkening)
 *   6. Optional lightning flash (background brightens for N frames)
 *
 * All buffers are pre-allocated — the render loop never allocates, which
 * keeps input lag at 0 ms and the frame rate at 60/120 FPS.
 */

import type { GlyphId, IconAnim, PixelFrame } from './pixel_bitmaps';
import { GLYPHS } from './pixel_bitmaps';
import { charAdvance, glyphFor, textWidth } from './bitmap_font';

/* ------------------------------------------------------------------ *
 *  Virtual display constants
 * ------------------------------------------------------------------ */

export const LCD_W = 104;
export const LCD_H = 64;

export const COLOR_ON = '#0f380f';
export const COLOR_OFF_TOP = '#9bbc0f';
export const COLOR_OFF_BOTTOM = '#8bac0f';
export const COLOR_GRID = '#306230';

/** Allowed integer upscale factors for the physical canvas. */
const MIN_SCALE = 2;
const MAX_SCALE = 10;

/** Dither grain advances one tile every N ms. */
const DITHER_STEP_MS = 120;

/* ------------------------------------------------------------------ *
 *  Color helpers (module-level, computed once)
 * ------------------------------------------------------------------ */

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

const OFF_TOP = hexToRgb(COLOR_OFF_TOP);
const OFF_BOTTOM = hexToRgb(COLOR_OFF_BOTTOM);
const ON_RGB = hexToRgb(COLOR_ON);

/** Per-row OFF colour — vertical gradient from top to bottom of the LCD. */
const OFF_ROWS: [number, number, number][] = (() => {
  const rows: [number, number, number][] = [];
  for (let y = 0; y < LCD_H; y++) {
    rows.push(mix(OFF_TOP, OFF_BOTTOM, y / (LCD_H - 1)));
  }
  return rows;
})();

/* ------------------------------------------------------------------ *
 *  Renderer
 * ------------------------------------------------------------------ */

export class LcdRenderer {
  private readonly host: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  /** 0 = pixel OFF, 1 = pixel ON. */
  private readonly buffer: Uint8Array;

  private readonly bufferCanvas: HTMLCanvasElement;
  private readonly bufferCtx: CanvasRenderingContext2D;
  private readonly imageData: ImageData;

  private scale = 4;
  private gridPattern: CanvasPattern | null = null;
  private vignette: HTMLCanvasElement | null = null;
  private noisePatterns: CanvasPattern[] = [];
  private ditherTick = 0;
  private ditherTimer = 0;
  private flashFrames = 0;

  constructor(canvas: HTMLCanvasElement, host: HTMLElement) {
    this.canvas = canvas;
    this.host = host;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('LcdRenderer: canvas 2d context unavailable');
    this.ctx = ctx;

    this.buffer = new Uint8Array(LCD_W * LCD_H);

    this.bufferCanvas = document.createElement('canvas');
    this.bufferCanvas.width = LCD_W;
    this.bufferCanvas.height = LCD_H;
    const bctx = this.bufferCanvas.getContext('2d');
    if (!bctx) throw new Error('LcdRenderer: buffer 2d context unavailable');
    this.bufferCtx = bctx;
    this.imageData = bctx.createImageData(LCD_W, LCD_H);

    this.buildNoisePatterns();
    this.resize();
  }

  /** Current integer upscale factor (2..10). */
  get scaleValue(): number {
    return this.scale;
  }

  /**
   * Refit the canvas to the host box and rebuild scale-dependent overlays.
   * Call once on start and from a ResizeObserver.
   */
  resize(): void {
    const rect = this.host.getBoundingClientRect();
    const raw = Math.floor(
      Math.min(rect.width / LCD_W, rect.height / LCD_H)
    );
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw));
    this.canvas.width = LCD_W * this.scale;
    this.canvas.height = LCD_H * this.scale;
    this.buildGridPattern();
    this.buildVignette();
  }

  /* --------------------------- buffer drawing ------------------------ */

  /** Clear the virtual framebuffer (all pixels OFF). */
  clear(): void {
    this.buffer.fill(0);
  }

  setPixel(x: number, y: number, on = true): void {
    if (x < 0 || x >= LCD_W || y < 0 || y >= LCD_H) return;
    this.buffer[y * LCD_W + x] = on ? 1 : 0;
  }

  fillRect(x: number, y: number, w: number, h: number, on = true): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(LCD_W, x + w);
    const y1 = Math.min(LCD_H, y + h);
    if (x0 >= x1 || y0 >= y1) return;
    const v = on ? 1 : 0;
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * LCD_W;
      for (let xx = x0; xx < x1; xx++) this.buffer[row + xx] = v;
    }
  }

  hline(x: number, y: number, w: number, on = true): void {
    this.fillRect(x, y, w, 1, on);
  }

  vline(x: number, y: number, h: number, on = true): void {
    this.fillRect(x, y, 1, h, on);
  }

  /** 1px rectangle outline. */
  frame(x: number, y: number, w: number, h: number, on = true): void {
    this.hline(x, y, w, on);
    this.hline(x, y + h - 1, w, on);
    this.vline(x, y, h, on);
    this.vline(x + w - 1, y, h, on);
  }

  /** Invert a rectangle (classic LCD list-selection highlight). */
  invertRect(x: number, y: number, w: number, h: number): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(LCD_W, x + w);
    const y1 = Math.min(LCD_H, y + h);
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * LCD_W;
      for (let xx = x0; xx < x1; xx++) {
        this.buffer[row + xx] = this.buffer[row + xx] ? 0 : 1;
      }
    }
  }

  /* ---------------------------- text & icons ------------------------- */

  /**
   * Draw text with the 5x7 bitmap font at integer scale.
   * Returns the x coordinate just past the last drawn character.
   */
  text(x: number, y: number, str: string, scale = 1): number {
    let cx = x;
    for (let i = 0; i < str.length; i++) {
      const g = glyphFor(str[i]);
      const top = y - g.top * scale;
      for (let gy = 0; gy < g.h; gy++) {
        const bits = g.rows[gy];
        const yy = top + gy * scale;
        if (yy < 0 || yy + scale > LCD_H) continue;
        for (let px = 0; px < 5; px++) {
          if ((bits & (1 << (4 - px))) === 0) continue;
          this.fillRect(cx + px * scale, yy, scale, scale, true);
        }
      }
      cx += charAdvance(scale);
    }
    return str.length > 0 ? cx - charAdvance(scale) : x;
  }

  /** Draw text horizontally centered on `cx`. */
  textCenter(cx: number, y: number, str: string, scale = 1): void {
    if (str.length === 0) return;
    this.text(Math.round(cx - textWidth(str, scale) / 2), y, str, scale);
  }

  /** Draw a pre-parsed pixel frame (16x16 icons, 8x8 glyphs) at 1:1. */
  bitmap(x: number, y: number, f: PixelFrame): void {
    for (let py = 0; py < f.h; py++) {
      const yy = y + py;
      if (yy < 0 || yy >= LCD_H) continue;
      const rowOff = py * f.w;
      for (let px = 0; px < f.w; px++) {
        if (f.data[rowOff + px] !== 1) continue;
        const xx = x + px;
        if (xx < 0 || xx >= LCD_W) continue;
        this.buffer[yy * LCD_W + xx] = 1;
      }
    }
  }

  /** Draw an animated weather icon at a given frame index (wraps). */
  icon(x: number, y: number, anim: IconAnim, frame: number): void {
    const n = anim.frames.length;
    this.bitmap(x, y, anim.frames[((frame % n) + n) % n]);
  }

  /**
   * Draw an 8x8 reduced copy of a 16x16 icon (2x2 block sampling —
   * a target pixel lights up if any of the four source pixels is ON).
   * Used by the dense day tables where a full icon would not fit.
   */
  miniIcon(x: number, y: number, anim: IconAnim, frame: number): void {
    const n = anim.frames.length;
    const f = anim.frames[((frame % n) + n) % n];
    for (let py = 0; py < 8; py++) {
      const yy = y + py;
      if (yy < 0 || yy >= LCD_H) continue;
      for (let px = 0; px < 8; px++) {
        const s = py * 2 * f.w + px * 2;
        if (
          f.data[s] === 1 ||
          f.data[s + 1] === 1 ||
          f.data[s + f.w] === 1 ||
          f.data[s + f.w + 1] === 1
        ) {
          this.setPixel(x + px, yy);
        }
      }
    }
  }

  /** Draw an 8x8 UI glyph (gps / mic / search / scroll arrows). */
  glyph(x: number, y: number, id: GlyphId): void {
    this.bitmap(x, y, GLYPHS[id]);
  }

  /* ------------------------------- present --------------------------- */

  /**
   * Schedule a lightning flash: the background brightens for the next
   * `frames` present() calls. The UI calls this while the current
   * condition is a thunderstorm.
   */
  flash(frames = 2): void {
    this.flashFrames = Math.max(this.flashFrames, frames);
  }

  /**
   * Blit the virtual buffer to the visible canvas.
   * Call exactly once per rAF frame; `dtMs` drives the dither grain.
   */
  present(dtMs: number): void {
    // 1. Compose the 104x64 ImageData
    const n = LCD_W * LCD_H;
    const data = this.imageData.data;
    for (let i = 0; i < n; i++) {
      const o = i << 2;
      if (this.buffer[i] === 1) {
        data[o] = ON_RGB[0];
        data[o + 1] = ON_RGB[1];
        data[o + 2] = ON_RGB[2];
      } else {
        const row = OFF_ROWS[(i / LCD_W) | 0];
        data[o] = row[0];
        data[o + 1] = row[1];
        data[o + 2] = row[2];
      }
      data[o + 3] = 255;
    }
    this.bufferCtx.putImageData(this.imageData, 0, 0);

    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // 2. Nearest-neighbour upscale
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.bufferCanvas, 0, 0, w, h);

    // 3. LCD pixel lattice
    if (this.gridPattern) {
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = this.gridPattern;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    // 4. Animated dither grain
    this.ditherTimer += dtMs;
    if (this.ditherTimer >= DITHER_STEP_MS) {
      this.ditherTimer -= DITHER_STEP_MS;
      this.ditherTick++;
    }
    if (this.noisePatterns.length > 0) {
      ctx.globalAlpha = 0.05;
      ctx.fillStyle = this.noisePatterns[this.ditherTick % this.noisePatterns.length];
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    // 5. Vignette
    if (this.vignette) {
      ctx.drawImage(this.vignette, 0, 0, w, h);
    }

    // 6. Lightning flash
    if (this.flashFrames > 0) {
      this.flashFrames--;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = COLOR_OFF_TOP;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /* ------------------------------ overlays --------------------------- */

  /** 1px lattice: bottom + right edge of every virtual cell, at scale. */
  private buildGridPattern(): void {
    const s = this.scale;
    const c = document.createElement('canvas');
    c.width = s;
    c.height = s;
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, s, s);
    g.strokeStyle = COLOR_GRID;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, s - 0.5);
    g.lineTo(s, s - 0.5);
    g.moveTo(s - 0.5, 0);
    g.lineTo(s - 0.5, s);
    g.stroke();
    this.gridPattern = this.ctx.createPattern(c, 'repeat');
  }

  /** Radial edge darkening, pre-rendered at canvas size. */
  private buildVignette(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return;
    const r = Math.max(w, h) * 0.75;
    const grad = g.createRadialGradient(w / 2, h / 2, r * 0.45, w / 2, h / 2, r);
    grad.addColorStop(0, 'rgba(15, 56, 15, 0)');
    grad.addColorStop(1, 'rgba(15, 56, 15, 0.22)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    this.vignette = c;
  }

  /** Four 16x16 noise tiles for the animated LCD grain. */
  private buildNoisePatterns(): void {
    for (let t = 0; t < 4; t++) {
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 16;
      const g = c.getContext('2d');
      if (!g) continue;
      let seed = (0x9e3779b9 ^ (t * 0x85ebca6b)) >>> 0;
      const rnd = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const img = g.createImageData(16, 16);
      for (let i = 0; i < img.data.length; i += 4) {
        const on = rnd() < 0.25;
        img.data[i] = ON_RGB[0];
        img.data[i + 1] = ON_RGB[1];
        img.data[i + 2] = ON_RGB[2];
        img.data[i + 3] = on ? 255 : 0;
      }
      g.putImageData(img, 0, 0);
      const p = this.ctx.createPattern(c, 'repeat');
      if (p) this.noisePatterns.push(p);
    }
  }
}
