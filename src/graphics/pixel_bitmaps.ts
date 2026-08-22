/**
 * NOKIA 3310 WEATHER RETRO — procedural pixel bitmaps.
 *
 * Every icon is a small set of 16x16 monochrome frames (2-4 frame loops),
 * encoded as ASCII bitmaps ('1' = pixel ON). Frames are pre-parsed into
 * Uint8Array bitmaps at module init so the render loop never touches
 * string data.
 *
 * Icons: sun / partcloud / cloud / fog / rain / thunder / snow / wind
 * Glyphs (8x8): gps pin, microphone, magnifier, scroll arrows.
 */

import type { IconId } from '../types/weather';

/* ------------------------------------------------------------------ *
 *  Types
 * ------------------------------------------------------------------ */

export interface PixelFrame {
  w: number;
  h: number;
  data: Uint8Array;
}

export interface IconAnim {
  w: number;
  h: number;
  frames: PixelFrame[];
  /** Animation speed in frames/second (retro 6-8 fps feel). */
  fps: number;
}

export type GlyphId =
  | 'gps'
  | 'mic'
  | 'search'
  | 'arrowUp'
  | 'arrowDown'
  | 'arrowLeft'
  | 'arrowRight';

/* ------------------------------------------------------------------ *
 *  Parser
 * ------------------------------------------------------------------ */

function parseFrame(rows: string[]): PixelFrame {
  const h = rows.length;
  const w = rows[0].length;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    if (row.length !== w) {
      throw new Error(`pixel bitmap row ${y} has width ${row.length}, expected ${w}`);
    }
    for (let x = 0; x < w; x++) {
      const c = row.charCodeAt(x);
      if (c !== 48 && c !== 49) {
        throw new Error(`invalid pixel char '${row[x]}' at (${x},${y})`);
      }
      data[y * w + x] = c === 49 ? 1 : 0;
    }
  }
  return { w, h, data };
}

const F = parseFrame;

/* ------------------------------------------------------------------ *
 *  SUN — 2 frames (rays rotate 45°)
 * ------------------------------------------------------------------ */

const SUN_F0 = F([
  '0000000110000000',
  '0000000110000000',
  '0000000110000000',
  '0000000110000000',
  '0000000000000000',
  '0000001111000000',
  '0000011111100000',
  '1111011111101111',
  '1111011111101111',
  '0000011111100000',
  '0000001111000000',
  '0000000000000000',
  '0000000110000000',
  '0000000110000000',
  '0000000110000000',
  '0000000110000000'
]);

const SUN_F1 = F([
  '0000000000000000',
  '0000000000000000',
  '0100000000000100',
  '0110000000000110',
  '0011000000001100',
  '0000001111000000',
  '0000011111100000',
  '0000011111100000',
  '0000011111100000',
  '0000011111100000',
  '0000001111000000',
  '0011000000001100',
  '0011000000000110',
  '0100000000000100',
  '0000000000000000',
  '0000000000000000'
]);

/* ------------------------------------------------------------------ *
 *  PARTCLOUD — small sun + drifting cloud, 3 frames
 * ------------------------------------------------------------------ */

const PARTCLOUD_SUN = [
  '0001000000000000',
  '0011100000000000',
  '0111110000000000',
  '1111111000000000',
  '1111111000000000',
  '0111110000000000',
  '0011100000000000'
];

const PARTCLOUD_CLOUDS: string[][] = [
  [
    '0001111111100000',
    '0011111111110000',
    '0111111111111100',
    '1111111111111111',
    '1111111111111111',
    '0111111111111100',
    '0011111111111000',
    '0001111111100000'
  ],
  [
    '0000111111100000',
    '0001111111111000',
    '0011111111111110',
    '0111111111111111',
    '0111111111111111',
    '0011111111111110',
    '0001111111111000',
    '0000111111100000'
  ],
  [
    '0000011111110000',
    '0000111111111100',
    '0001111111111111',
    '0011111111111111',
    '0011111111111111',
    '0001111111111111',
    '0000111111111100',
    '0000011111110000'
  ]
];

const PARTCLOUD_F0 = F(PARTCLOUD_SUN.concat(PARTCLOUD_CLOUDS[0]));
const PARTCLOUD_F1 = F(PARTCLOUD_SUN.concat(PARTCLOUD_CLOUDS[1]));
const PARTCLOUD_F2 = F(PARTCLOUD_SUN.concat(PARTCLOUD_CLOUDS[2]));

/* ------------------------------------------------------------------ *
 *  CLOUD — big puffy cloud, 2 frames (1px drift)
 * ------------------------------------------------------------------ */

const CLOUD_F0 = F([
  '0000000000000000',
  '0000000000000000',
  '0000000000000000',
  '0000111111110000',
  '0001111111111000',
  '0011111111111100',
  '0111111111111110',
  '0111111111111111',
  '0111111111111111',
  '0011111111111110',
  '0001111111111000',
  '0000111111110000',
  '0000000000000000',
  '0000000000000000',
  '0000000000000000',
  '0000000000000000'
]);

const CLOUD_F1 = F([
  '0000000000000000',
  '0000000000000000',
  '0000000000000000',
  '0000011111111000',
  '0000111111111100',
  '0001111111111110',
  '0011111111111111',
  '0111111111111111',
  '0111111111111111',
  '0011111111111111',
  '0001111111111100',
  '0000111111111000',
  '0000000000000000',
  '0000000000000000',
  '0000000000000000',
  '0000000000000000'
]);

/* ------------------------------------------------------------------ *
 *  RAIN — cloud + falling diagonal drops, 4 frames
 * ------------------------------------------------------------------ */

const RAIN_CLOUD = [
  '0000000000000000',
  '0000000000000000',
  '0011111111110000',
  '0111111111111100',
  '1111111111111111',
  '1111111111111111',
  '0111111111111100'
];
const RAIN_DROPS_A = [
  '0000100010001000',
  '0000100010001000',
  '0001000100010000'
];
const RAIN_ZEROS = '0000000000000000';

/** All three drops fall in unison; `rowTop` is the top row of the drops. */
const rainFrame = (rowTop: number): PixelFrame => {
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    let row = RAIN_ZEROS;
    if (y < 7) row = RAIN_CLOUD[y];
    if (y === rowTop) row = RAIN_DROPS_A[0];
    else if (y === rowTop + 1) row = RAIN_DROPS_A[1];
    else if (y === rowTop + 2) row = RAIN_DROPS_A[2];
    rows.push(row);
  }
  return F(rows);
};

const RAIN_F0 = rainFrame(7);
const RAIN_F1 = rainFrame(9);
const RAIN_F2 = rainFrame(11);
const RAIN_F3 = rainFrame(13);

/* ------------------------------------------------------------------ *
 *  THUNDER — cloud + flashing bolt, 4 frames (flash on odd frames)
 * ------------------------------------------------------------------ */

const THUNDER_BOLT = [
  '0000000000000000', // 7
  '0000001100000000', // 8
  '0000011000000000', // 9
  '0000110000000000', // 10
  '0001111100000000', // 11
  '0000011000000000', // 12
  '0000001100000000', // 13
  '0000000100000000', // 14
  '0000000000000000'  // 15
];

const thunderFrame = (bolt: boolean): PixelFrame => {
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    if (y < 7) rows.push(RAIN_CLOUD[y] ?? RAIN_ZEROS);
    else rows.push(bolt ? THUNDER_BOLT[y - 7] : RAIN_ZEROS);
  }
  return F(rows);
};

const THUNDER_F0 = thunderFrame(false);
const THUNDER_F1 = thunderFrame(true);
const THUNDER_F2 = thunderFrame(false);
const THUNDER_F3 = thunderFrame(true);

/* ------------------------------------------------------------------ *
 *  SNOW — cloud + drifting 2x2 flakes, 4 frames
 * ------------------------------------------------------------------ */

const snowFrame = (cells: Array<[number, number]>): PixelFrame => {
  const rows: string[] = Array.from({ length: 16 }, () => RAIN_ZEROS);
  for (const [fx, fy] of cells) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const y = fy + dy;
        const x = fx + dx;
        if (x < 0 || x > 15 || y < 0 || y > 15) continue;
        const chars = rows[y].split('');
        chars[x] = '1';
        rows[y] = chars.join('');
      }
    }
  }
  for (let y = 0; y < 7; y++) rows[y] = RAIN_CLOUD[y];
  return F(rows);
};

const SNOW_F0 = snowFrame([
  [3, 8], [7, 10], [11, 8], [13, 10]
]);
const SNOW_F1 = snowFrame([
  [4, 10], [6, 12], [12, 10], [14, 12]
]);
const SNOW_F2 = snowFrame([
  [3, 12], [7, 14], [11, 12], [13, 14]
]);
const SNOW_F3 = snowFrame([
  [4, 14], [6, 8], [12, 14], [14, 8]
]);

/* ------------------------------------------------------------------ *
 *  FOG — raster lines sliding, 3 frames
 * ------------------------------------------------------------------ */

const FOG_F0 = F([
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0011111111100000',
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0000011111111100',
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0111111111100000',
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0000111111111000',
  RAIN_ZEROS,
  RAIN_ZEROS
]);

const FOG_F1 = F([
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0001111111110000',
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0000001111111111',
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0011111111110000',
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0000011111111100',
  RAIN_ZEROS,
  RAIN_ZEROS
]);

const FOG_F2 = F([
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0000111111111000',
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0000000111111111',
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0001111111111000',
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0000001111111111',
  RAIN_ZEROS,
  RAIN_ZEROS
]);

/* ------------------------------------------------------------------ *
 *  WIND — three hooked lines sliding, 3 frames
 * ------------------------------------------------------------------ */

const WIND_F0 = F([
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0000000000010000',
  '0011111111110000',
  RAIN_ZEROS,
  '0000000001000000',
  '0111111111000000',
  RAIN_ZEROS,
  '0000000000001000',
  '0001111111111000',
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS
]);

const WIND_F1 = F([
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0000000000001000',
  '0001111111111000',
  RAIN_ZEROS,
  '0000000000100000',
  '0011111111100000',
  RAIN_ZEROS,
  '0000000000000100',
  '0000111111111100',
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS
]);

const WIND_F2 = F([
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  '0000000000000100',
  '0000111111111100',
  RAIN_ZEROS,
  '0000000000010000',
  '0001111111110000',
  RAIN_ZEROS,
  '0000000000000010',
  '0000011111111110',
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS,
  RAIN_ZEROS
]);

/* ------------------------------------------------------------------ *
 *  8x8 UI glyphs
 * ------------------------------------------------------------------ */

const GLYPH_GPS = F([
  '00111100',
  '01111110',
  '11100111',
  '11100111',
  '11111111',
  '01111110',
  '00111100',
  '00011000'
]);

const GLYPH_MIC = F([
  '00111100',
  '01111110',
  '01111110',
  '00111100',
  '01111110',
  '00111100',
  '00111100',
  '01111110'
]);

const GLYPH_SEARCH = F([
  '01111100',
  '10000100',
  '10000100',
  '10000100',
  '01111110',
  '00000111',
  '00000001',
  '00000001'
]);

const GLYPH_ARROW_UP = F([
  '00011000',
  '00111100',
  '01111110',
  '11111111',
  '00000000',
  '00000000',
  '00000000',
  '00000000'
]);

const GLYPH_ARROW_DOWN = F([
  '00000000',
  '00000000',
  '00000000',
  '00000000',
  '11111111',
  '01111110',
  '00111100',
  '00011000'
]);

const GLYPH_ARROW_LEFT = F([
  '10000000',
  '11000000',
  '11100000',
  '11110000',
  '11100000',
  '11000000',
  '10000000',
  '00000000'
]);

const GLYPH_ARROW_RIGHT = F([
  '00000001',
  '00000011',
  '00000111',
  '00001111',
  '00000111',
  '00000011',
  '00000001',
  '00000000'
]);

/* ------------------------------------------------------------------ *
 *  Exports
 * ------------------------------------------------------------------ */

/** Large animated sun with a small drifting cloud for low cloud cover. */
function sunCloudFrame(sun: PixelFrame, cloudShift: number): PixelFrame {
  const data = new Uint8Array(16 * 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const sx = x - 3;
      const sy = y + 2;
      if (sx >= 0 && sx < 16 && sy >= 0 && sy < 16 && sun.data[sy * 16 + sx]) {
        data[y * 16 + x] = 1;
      }
    }
  }
  const cloud = [
    '00011100000',
    '00111110000',
    '01111111100',
    '11111111110',
    '01111111100'
  ];
  for (let y = 0; y < cloud.length; y++) {
    for (let x = 0; x < cloud[y].length; x++) {
      if (cloud[y][x] === '1') data[(10 + y) * 16 + x + cloudShift] = 1;
    }
  }
  return { w: 16, h: 16, data };
}

const SUNCLOUD_F0 = sunCloudFrame(SUN_F0, 0);
const SUNCLOUD_F1 = sunCloudFrame(SUN_F1, 1);

export const WEATHER_ICONS: Record<IconId, IconAnim> = {
  sun: { w: 16, h: 16, frames: [SUN_F0, SUN_F1], fps: 4 },
  suncloud: { w: 16, h: 16, frames: [SUNCLOUD_F0, SUNCLOUD_F1], fps: 4 },
  partcloud: {
    w: 16,
    h: 16,
    frames: [PARTCLOUD_F0, PARTCLOUD_F1, PARTCLOUD_F2],
    fps: 3
  },
  cloud: { w: 16, h: 16, frames: [CLOUD_F0, CLOUD_F1], fps: 2 },
  fog: { w: 16, h: 16, frames: [FOG_F0, FOG_F1, FOG_F2], fps: 3 },
  rain: {
    w: 16,
    h: 16,
    frames: [RAIN_F0, RAIN_F1, RAIN_F2, RAIN_F3],
    fps: 6
  },
  thunder: {
    w: 16,
    h: 16,
    frames: [THUNDER_F0, THUNDER_F1, THUNDER_F2, THUNDER_F3],
    fps: 6
  },
  snow: {
    w: 16,
    h: 16,
    frames: [SNOW_F0, SNOW_F1, SNOW_F2, SNOW_F3],
    fps: 4
  },
  wind: { w: 16, h: 16, frames: [WIND_F0, WIND_F1, WIND_F2], fps: 3 }
};

export const GLYPHS: Record<GlyphId, PixelFrame> = {
  gps: GLYPH_GPS,
  mic: GLYPH_MIC,
  search: GLYPH_SEARCH,
  arrowUp: GLYPH_ARROW_UP,
  arrowDown: GLYPH_ARROW_DOWN,
  arrowLeft: GLYPH_ARROW_LEFT,
  arrowRight: GLYPH_ARROW_RIGHT
};
