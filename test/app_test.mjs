/**
 * Pogodynka 3310 — automated functional test of ALL app features.
 *
 * - Browser: system Microsoft Edge (Playwright channel "msedge", headless)
 * - Context: mobile viewport 420x900, touch enabled, geolocation = Kraków
 * - State is read from the running UI via the window.__UI__ debug hook
 * - Deliberate delays between actions (user requirement)
 * - Screenshots: test/shots/NN-name.png
 *
 * Run (dev server must be running on :5173):
 *   set "PATH=D:\pinokio\bin\miniconda;%PATH%"
 *   node test\app_test.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const URL = process.env.APP_URL || 'http://localhost:5173/';
const GAP = 400; // deliberate delay between actions (ms)

const results = [];
const consoleErrors = [];
const pageErrors = [];
let shotIdx = 0;
let page;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, extra = '') {
  results.push({ name, ok: !!ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   [' + extra + ']' : ''}`);
}

async function shot(name) {
  shotIdx += 1;
  const f = path.join(SHOTS, `${String(shotIdx).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f }).catch(() => {});
}

/** Read the live UI state through the __UI__ hook (TS private is compile-time only). */
async function state() {
  return page.evaluate(() => {
    const ui = window.__UI__;
    if (!ui) return null;
    return {
      screen: ui.screen,
      lastTab: ui.lastTab,
      city: ui.city ? ui.city.name : null,
      hasSnap: !!ui.snapshot,
      source: ui.snapshot ? ui.snapshot.source : null,
      loading: ui.loading,
      query: ui.query,
      nResults: ui.results.length,
      resultIndex: ui.resultIndex,
      searchStatus: ui.searchStatus,
      menuIndex: ui.menuIndex,
      weekOffset: ui.weekOffset,
      gpsBusy: ui.gpsBusy,
      gpsStatus: ui.gpsStatus,
      voiceMsg: ui.voiceMsg,
      toastMsg: ui.toastMsg,
      wantsInput: ui.wantsInput,
      maxTouch: navigator.maxTouchPoints,
    };
  });
}

/** Tap a point in virtual LCD coordinates (0..103, 0..63). */
async function tapV(vx, vy) {
  const rect = await page.evaluate(() => {
    const r = document.querySelector('#lcd').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  await page.touchscreen.tap(
    rect.left + (vx / 104) * rect.width,
    rect.top + (vy / 64) * rect.height,
  );
  await sleep(GAP);
}

/** Swipe on the LCD. dx/dy = finger displacement in client px (negative = left/up). */
async function swipeV(dx, dy) {
  await page.evaluate(
    ([dx, dy]) => {
      const c = document.querySelector('#lcd');
      const r = c.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const mk = (x, y, type) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 7,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY: y,
        });
      c.dispatchEvent(mk(cx - dx / 2, cy - dy / 2, 'pointerdown'));
      c.dispatchEvent(mk(cx, cy, 'pointermove'));
      c.dispatchEvent(mk(cx + dx / 2, cy + dy / 2, 'pointerup'));
    },
    [dx, dy],
  );
  await sleep(GAP);
}

async function press(key) {
  await page.keyboard.press(key);
  await sleep(GAP);
}

/** Poll until fn() returns a truthy value (or null on timeout). */
async function poll(fn, timeoutMs = 20000, everyMs = 500) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(everyMs);
  }
}

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 420, height: 900 },
    hasTouch: true,
    isMobile: true,
    locale: 'pl-PL',
    geolocation: { latitude: 50.0647, longitude: 19.945 }, // Kraków
    permissions: ['geolocation'],
  });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  console.log(`== Pogodynka 3310 test: ${URL} ==`);

  // --- 1) load, then disable service worker + caches (never shadow dev) ----
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page
    .evaluate(async () => {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    })
    .catch(() => {});

  const s0 = await state();
  check('UI hook (window.__UI__) available', !!s0);
  check(
    'touch emulation active (maxTouchPoints > 0)',
    !!(s0 && s0.maxTouch > 0),
    `maxTouch=${s0 ? s0.maxTouch : '?'}`,
  );
  if (!s0) {
    console.log('ABORT: app did not start. Page errors:', pageErrors);
    await browser.close();
    process.exit(1);
  }

  // --- 2) boot splash -> today ---------------------------------------------
  await sleep(2600);
  let s = await state();
  check('boot splash ends -> today screen', s.screen === 'today', `screen=${s.screen}`);

  // --- 3) initial weather data (default city WARSZAWA) ---------------------
  s = await poll(async () => {
    const st = await state();
    return st.hasSnap && !st.loading ? st : null;
  }, 25000, 700);
  check(
    'initial weather data loaded (WARSZAWA)',
    !!(s && s.hasSnap && s.city === 'WARSZAWA'),
    `city=${s && s.city} source=${s && s.source}`,
  );
  await shot('today');

  // --- 4) tab switching via keyboard (RIGHT/LEFT wrap) ---------------------
  await press('ArrowRight');
  s = await state();
  check('ArrowRight -> week', s.screen === 'week', `screen=${s.screen}`);
  await shot('week');
  await press('ArrowRight');
  s = await state();
  check('ArrowRight -> twoweeks', s.screen === 'twoweeks', `screen=${s.screen}`);
  await press('ArrowRight');
  s = await state();
  check('ArrowRight -> month', s.screen === 'month', `screen=${s.screen}`);
  await shot('month');
  await press('ArrowLeft');
  await press('ArrowLeft');
  await press('ArrowLeft');
  s = await state();
  check('ArrowLeft x3 -> today', s.screen === 'today', `screen=${s.screen}`);

  // --- 5) week scrolling (UP/DOWN) -----------------------------------------
  await press('ArrowRight'); // week
  await press('ArrowDown');
  s = await state();
  check(
    'week: ArrowDown scrolls forward',
    s.screen === 'week' && s.weekOffset === 1,
    `weekOffset=${s.weekOffset}`,
  );
  await press('ArrowUp');
  s = await state();
  check('week: ArrowUp scrolls back', s.weekOffset === 0, `weekOffset=${s.weekOffset}`);
  await press('ArrowLeft'); // back to today

  // --- 6) tab bar tap (touch) ----------------------------------------------
  await tapV(60, 12);
  s = await state();
  check('tap tab "2TYG" -> twoweeks', s.screen === 'twoweeks', `screen=${s.screen}`);
  await tapV(13, 12);
  s = await state();
  check('tap tab "DZIŚ" -> today', s.screen === 'today', `screen=${s.screen}`);

  // --- 7) bottom button OK -> menu ------------------------------------------
  await page.click('button[data-key="SOFTL"]');
  await sleep(GAP);
  s = await state();
  check(
    'bottom button OK -> menu',
    s.screen === 'menu' && s.menuIndex === 0,
    `screen=${s.screen} menuIndex=${s.menuIndex}`,
  );
  await shot('menu');

  // --- 8) voice (menu item 3) ----------------------------------------------
  await press('ArrowDown');
  await press('ArrowDown');
  s = await state();
  check('menu: ArrowDown x2 -> GŁOS', s.menuIndex === 2, `menuIndex=${s.menuIndex}`);
  await press('Enter');
  s = await state();
  const voiceOk = s.screen === 'voice' || s.toastMsg === 'BRAK WSPARCIA MOWY';
  check('voice: opens screen (or unsupported toast)', voiceOk, `screen=${s.screen} toast=${s.toastMsg}`);
  if (s.screen === 'voice') {
    await shot('voice');
    check('voice: message shown', !!s.voiceMsg, `msg=${s.voiceMsg}`);
    await press('Escape');
    s = await state();
    check('voice: Escape -> today', s.screen === 'today', `screen=${s.screen}`);
  }

  // --- 9) GPS (menu item 2) via LCD taps ------------------------------------
  await tapV(20, 58); // left softkey strip -> menu
  s = await state();
  check('tap LCD left softkey -> menu', s.screen === 'menu', `screen=${s.screen}`);
  await tapV(50, 25); // menu item row y=25 -> index 1: GPS - POZYCJA
  s = await state();
  check(
    'tap menu item GPS -> gps screen',
    s.screen === 'gps' && s.gpsStatus === 'GOTOWY',
    `screen=${s.screen} gpsStatus=${s.gpsStatus}`,
  );
  await shot('gps-ready');
  await tapV(50, 30); // content tap = OK -> start
  s = await poll(async () => {
    const st = await state();
    return st.screen === 'today' && st.city && st.city !== 'WARSZAWA' && !st.loading
      ? st
      : null;
  }, 30000, 700);
  check(
    'GPS: located (Kraków) and city loaded',
    !!(s && s.city && s.city !== 'WARSZAWA'),
    `city=${s && s.city} gpsBusy=${s && s.gpsBusy} gpsStatus=${s && s.gpsStatus}`,
  );
  await shot('gps-loaded');

  // --- 10) search (right softkey) + phone-keyboard typing --------------------
  await tapV(85, 58);
  s = await state();
  check(
    'tap LCD right softkey -> search',
    s.screen === 'search' && s.wantsInput,
    `screen=${s.screen}`,
  );
  const vkFocused = await page.evaluate(
    () => !!document.activeElement && document.activeElement.className === 'vk',
  );
  check('hidden input focused (phone keyboard would open)', vkFocused);
  for (const ch of ['k', 'r', 'a']) await press(ch);
  s = await state();
  check('typed "kra" -> query KRA (uppercased)', s.query === 'KRA', `query=${s.query}`);
  s = await poll(async () => {
    const st = await state();
    return st.nResults > 0 ? st : null;
  }, 15000, 700);
  check(
    'geocoding returned results',
    !!(s && s.nResults > 0),
    `nResults=${s && s.nResults} status=${s && s.searchStatus}`,
  );
  await shot('search-results');

  // --- 11) Backspace + multi-tap (2-2-2 -> C) --------------------------------
  for (let i = 0; i < 5; i++) await press('Backspace');
  s = await state();
  check('Backspace x5 clears query', s.query === '', `query=${s.query}`);
  await page.keyboard.press('2');
  await sleep(250);
  await page.keyboard.press('2');
  await sleep(250);
  await page.keyboard.press('2');
  await sleep(1100);
  s = await state();
  check('multi-tap 2-2-2 -> C', s.query === 'C', `query=${s.query}`);

  // --- 12) bottom button ANULUJ on search -> clears field ---------------------
  await page.click('button[data-key="SOFT"]');
  await sleep(GAP);
  s = await state();
  check(
    'bottom button ANULUJ clears search',
    s.query === '' && s.nResults === 0 && s.searchStatus === '',
    `query=${s.query} n=${s.nResults} status=${s.searchStatus}`,
  );

  // --- 13) retype + tap first result row --------------------------------------
  for (const ch of ['k', 'r', 'a']) await press(ch);
  await poll(async () => {
    const st = await state();
    return st.nResults > 0 ? st : null;
  }, 15000, 700);
  await tapV(30, 25); // first visible result row
  s = await poll(async () => {
    const st = await state();
    return st.screen === 'today' && st.hasSnap && !st.loading ? st : null;
  }, 25000, 700);
  check(
    'tap result -> city loaded on today',
    !!(s && s.screen === 'today' && s.hasSnap && !s.loading),
    `city=${s && s.city} source=${s && s.source}`,
  );
  await shot('result-loaded');

  // --- 14) menu: ODŚWIEŻ DANE (item 4) ---------------------------------------
  await tapV(20, 58);
  await press('ArrowDown');
  await press('ArrowDown');
  await press('ArrowDown');
  s = await state();
  check(
    'menu: ArrowDown x3 -> ODŚWIEŻ DANE',
    s.screen === 'menu' && s.menuIndex === 3,
    `screen=${s.screen} menuIndex=${s.menuIndex}`,
  );
  await press('Enter');
  s = await poll(async () => {
    const st = await state();
    return !st.loading ? st : null;
  }, 25000, 700);
  check('refresh finished', !!(s && !s.loading && s.hasSnap), `loading=${s && s.loading}`);

  // --- 15) menu: WYCZYŚĆ CACHE (item 5) ---------------------------------------
  await tapV(20, 58);
  await press('ArrowDown');
  await press('ArrowDown');
  await press('ArrowDown');
  await press('ArrowDown');
  s = await state();
  check('menu: ArrowDown x4 -> WYCZYŚĆ CACHE', s.menuIndex === 4, `menuIndex=${s.menuIndex}`);
  await press('Enter');
  await sleep(300);
  s = await state();
  check('cache cleared toast', s.toastMsg === 'WYCZYSZCZONO', `toast=${s.toastMsg}`);
  s = await poll(async () => {
    const st = await state();
    return st.hasSnap && !st.loading ? st : null;
  }, 30000, 700);
  check(
    'data reloaded after cache clear',
    !!(s && s.hasSnap && !s.loading),
    `source=${s && s.source}`,
  );

  // --- 16) swipe on LCD --------------------------------------------------------
  await swipeV(-120, 0); // finger moves left -> RIGHT key -> next tab
  s = await state();
  check('swipe left -> next tab (week)', s.screen === 'week', `screen=${s.screen}`);
  await shot('swipe-week');

  // --- 17) runtime errors ------------------------------------------------------
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log('================ PODSUMOWANIE ================');
  console.log(`TESTS: ${results.length}   PASS: ${results.length - failed.length}   FAIL: ${failed.length}`);
  for (const r of failed) console.log(`  FAIL: ${r.name}   ${r.extra}`);
  console.log(`Screenshots: ${SHOTS}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST CRASH:', e);
  process.exit(1);
});
