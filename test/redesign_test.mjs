import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'redesign-shots');
fs.mkdirSync(shots, { recursive: true });
const base = process.env.APP_URL || 'http://127.0.0.1:4174/';
const errors = [];
const checks = [];
const check = (name, ok) => { checks.push([name, Boolean(ok)]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };

const days = Array.from({ length: 16 }, (_, i) => `2026-08-${String(22 + i).padStart(2, '0')}`);
const times = Array.from({ length: 48 }, (_, i) => {
  const date = new Date(Date.UTC(2026, 7, 22, i));
  return date.toISOString().slice(0, 16);
});
const forecast = {
  latitude: 52.23, longitude: 21.01, timezone: 'Europe/Warsaw',
  current: { time: '2026-08-22T12:00', temperature_2m: 24.4, relative_humidity_2m: 68, apparent_temperature: 25.2, precipitation: 0, weather_code: 1, cloud_cover: 25, wind_speed_10m: 13, wind_direction_10m: 245, pressure_msl: 1015 },
  hourly: { time: times, temperature_2m: times.map((_, i) => 20 + Math.sin(i / 5) * 5), weather_code: times.map((_, i) => i % 8 === 0 ? 61 : 1), precipitation_probability: times.map((_, i) => i % 8 === 0 ? 62 : 8), wind_speed_10m: times.map((_, i) => 9 + i % 7), cloud_cover: times.map((_, i) => [5, 30, 65, 100][i % 4]) },
  daily: { time: days, weather_code: days.map((_, i) => [1, 2, 61, 3][i % 4]), temperature_2m_max: days.map((_, i) => 24 - i % 5), temperature_2m_min: days.map((_, i) => 14 - i % 3), precipitation_probability_max: days.map((_, i) => i % 3 * 25), wind_speed_10m_max: days.map((_, i) => 14 + i % 9), precipitation_sum: days.map((_, i) => i % 3 ? 1.2 : 0) },
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'pl-PL', geolocation: { latitude: 50.0647, longitude: 19.945 }, permissions: ['geolocation'], serviceWorkers: 'block' });
const page = await context.newPage();
await page.addInitScript(() => {
  const nativeSetInterval = window.setInterval.bind(window);
  window.__scheduledIntervals = [];
  window.setInterval = (handler, timeout, ...args) => {
    window.__scheduledIntervals.push(Number(timeout));
    return nativeSetInterval(handler, timeout, ...args);
  };
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.route('**/v1/forecast?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(forecast) }));
await page.route(/geocoding-api\.open-meteo\.com\/v1\/search/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [{ id: 1, name: 'Kraków', country: 'Polska', admin1: 'Małopolskie', latitude: 50.0647, longitude: 19.945, population: 800000 }] }) }));
await page.route('**/reverse-geocode-client?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ city: 'Kraków', countryName: 'Polska', principalSubdivision: 'Małopolskie' }) }));

await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-panel="today"] .metric-card', { timeout: 10000 });
check('pełna aplikacja uruchamia się', await page.locator('.weather-app').count() === 1);
check('brak napisu Pogodynka 3310', !(await page.locator('body').innerText()).includes('POGODYNKA 3310'));
const heroBounds = await page.evaluate(() => {
  const card = document.querySelector('.hero-card')?.getBoundingClientRect();
  const lcd = document.querySelector('.hero-lcd')?.getBoundingClientRect();
  return card && lcd ? { left: lcd.left - card.left, right: card.right - lcd.right } : null;
});
check('żółty LCD dochodzi do wewnętrznej krawędzi ramki', !!heroBounds && heroBounds.left <= 2 && heroBounds.right <= 2);
check('ekran główny ma osiem metryk, w tym procent opadów i chmur', await page.locator('.metric-card').count() === 8);
check('ostatnia prognoza jest zapisana dla trybu offline', await page.evaluate(() => localStorage.getItem('pogoda3310:last-successful-snapshot') != null));
await context.setOffline(true);
await page.waitForTimeout(150);
check('pełna aplikacja oznacza zapamiętane dane jako OFFLINE', (await page.locator('#updated-label').textContent())?.includes('OFFLINE'));
await context.setOffline(false);
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(shots, '01-full-app.png') });

await page.click('[data-section="hours"]');
check('prognoza godzinowa jest osobnym widokiem i pokazuje 24 godziny', await page.locator('[data-panel="hours"].active .hour-card').count() === 24);
check('temperatura i godzina są na wykresie, nie w kafelkach', await page.locator('.hour-card time, .hour-card > strong').count() === 0 && await page.locator('.chart-temp').count() === 24 && await page.locator('.chart-hour').count() === 24);
check('wykres ma przerywane prowadnice', await page.locator('.chart-guide').count() === 24);
check('kafelki mają animacje deszczu i warianty zachmurzenia', await page.locator('.hour-card .rain .rain-lines').count() > 0 && await page.locator('.hour-card .cloud-low, .hour-card .cloud-mid, .hour-card .cloud-high').count() > 0);
await page.screenshot({ path: path.join(shots, '02-hours.png') });
await page.click('[data-section="week"]');
check('prognoza 14 dni jest poza ekranem głównym', await page.locator('[data-panel="week"].active .forecast-row').count() === 14);
await page.click('[data-section="meteopath"]');
check('wskaźniki meteopaty mają osobne ikony', await page.locator('.sensitivity-icon').count() === 4);
const movingMeteoIcons = await page.evaluate(() => [...document.querySelectorAll('.sensitivity-icon')].filter((icon) => [...icon.querySelectorAll('i, b')].some((part) => getComputedStyle(part).animationName !== 'none')).length);
check('wszystkie ikony meteopaty są animowane', movingMeteoIcons === 4);
await page.waitForTimeout(450);
await page.screenshot({ path: path.join(shots, '03a-meteopath.png') });

await page.click('[data-action="search"]');
await page.fill('#city-search', 'Krak');
await page.waitForSelector('[data-city-index="0"]');
check('wyszukiwanie miejscowości działa', await page.locator('[data-city-index]').count() === 1);
await page.click('[data-city-index="0"]');
await page.waitForFunction(() => document.querySelector('#location-name')?.textContent === 'KRAKÓW');
check('wybór miejscowości aktualizuje aplikację', await page.locator('#location-name').textContent() === 'KRAKÓW');

await page.click('[data-action="menu"]');
await page.click('[data-skin="radar"]');
check('skórka Radar działa', await page.locator('.weather-app').getAttribute('data-skin') === 'radar');
await page.screenshot({ path: path.join(shots, '03-menu-radar.png') });

await page.goto(`${base}?view=widget`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
check('tryb widgetu nie ma przycisków atrapy telefonu', await page.locator('.softkeys, .phone-top, .caption').count() === 0);
check('widget ma tylko ekran LCD i otwieranie aplikacji', await page.locator('.widget-launcher #lcd').count() === 1);
check('widget planuje odświeżanie co 15 minut', await page.evaluate(() => window.__scheduledIntervals.includes(15 * 60 * 1000)));
await page.screenshot({ path: path.join(shots, '04-widget.png') });
await context.setOffline(true);
await page.waitForTimeout(200);
check('widget działa po utracie sieci', await page.locator('.widget-launcher #lcd').count() === 1);
await page.screenshot({ path: path.join(shots, '04b-widget-offline.png') });
await context.setOffline(false);
check('brak błędów strony i konsoli', errors.length === 0);

await page.setViewportSize({ width: 512, height: 512 });
await page.goto(`${base}icon.svg`, { waitUntil: 'load' });
await page.screenshot({ path: path.join(shots, '05-app-icon.png') });

await browser.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(`RESULT ${checks.length - failed.length}/${checks.length}`);
if (errors.length) console.log(errors.slice(0, 5));
process.exit(failed.length ? 1 : 0);
