/**
 * NOKIA 3310 WEATHER RETRO — WeatherService.
 *
 * Three-tier provider cascade with silent, automatic failover.
 * A provider counts as failed on: HTTP 4xx/5xx, network error,
 * or a request timeout longer than 3000 ms.
 *
 *   1. open-meteo  — keyless, up to 16 days (primary)
 *   2. met-no      — Yr.no grid, keyless, ~10 days
 *   3. weatherapi  — WeatherAPI.com, keyed, up to 14 days
 *
 * Also provides: geocoding (Open-Meteo), reverse geocoding (BigDataCloud)
 * and localStorage caching (weather TTL 10 min, geo TTL 24 h).
 */

import type {
  City,
  CurrentWeather,
  DayPoint,
  GeoPoint,
  HourPoint,
  MetNoForecastResponse,
  MetNoTimeseriesEntry,
  OpenMeteoForecastResponse,
  OpenMeteoGeocodeResponse,
  Provider,
  WeatherApiResponse,
  WeatherCondition,
  WeatherService,
  WeatherSnapshot,
} from '../types/weather';
import { conditionToIcon } from '../types/weather';

/* ------------------------------------------------------------------ *
 *  Constants
 * ------------------------------------------------------------------ */

/** Per-provider request budget — exceeded means "fail over silently". */
const PROVIDER_TIMEOUT_MS = 3000;

/** Optional WeatherAPI.com key (3rd provider). Never commit a production key. */
const WEATHERAPI_KEY: string = (import.meta.env.VITE_WEATHERAPI_KEY ?? '').trim();

/**
 * api.met.no requires a User-Agent identifying the app.
 * NOTE: browsers silently drop the forbidden User-Agent header, so met.no
 * may answer 403 in a pure browser — the cascade absorbs that and moves
 * on to WeatherAPI. The header is still sent for runtimes that honour it.
 */
const MET_NO_USER_AGENT = 'Pogoda3310Widget/2.0 (kontakt@twojadomena.pl)';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const OM_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const MET_NO_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const WX_API_URL = 'https://api.weatherapi.com/v1/forecast.json';
const REVERSE_GEO_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

const WX_CACHE_TTL_MS = 10 * 60 * 1000;       // 10 min
const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const CACHE_PREFIX = 'pogoda3310:v3';

/** Default location — instant first paint before any network round-trip. */
export const DEFAULT_CITY: City = {
  id: 'pl-warszawa',
  name: 'WARSZAWA',
  country: 'POLSKA',
  admin: 'MAZOWIECKIE',
  lat: 52.2297,
  lon: 21.0122
};

/* ------------------------------------------------------------------ *
 *  Errors
 * ------------------------------------------------------------------ */

/** Thrown when the whole cascade fails, or the caller aborted. */
export class WeatherError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'WeatherError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 *  Small helpers
 * ------------------------------------------------------------------ */

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Stable, short id for a string (cache keys). */
function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Weekday index 0=Sun..6=Sat for a YYYY-MM-DD date. */
function weekdayFromDate(date: string): number {
  const p = date.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getDay();
}

/* ------------------------------------------------------------------ *
 *  LocalStorage cache
 * ------------------------------------------------------------------ */

interface CacheEnvelope<T> {
  t: number; // written at (ms epoch)
  d: T;      // payload
}

function lsGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // private mode / corrupted entry
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — caching is best-effort */
  }
}

function readCache<T>(key: string, ttlMs: number): T | null {
  const env = lsGet<CacheEnvelope<T>>(key);
  if (!env || typeof env.t !== 'number') return null;
  if (Date.now() - env.t > ttlMs) return null;
  return env.d;
}

function writeCache<T>(key: string, data: T): void {
  const env: CacheEnvelope<T> = { t: Date.now(), d: data };
  lsSet(key, env);
}

/* ------------------------------------------------------------------ *
 *  HTTP + timeout plumbing
 * ------------------------------------------------------------------ */

/**
 * fetch + JSON. Non-2xx -> WeatherError('HTTP_xxx'); network failure ->
 * WeatherError('NETWORK'); aborts are rethrown untouched.
 */
async function httpJson<T>(
  url: string,
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers, cache: 'no-store' });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new WeatherError('NETWORK', `fetch failed: ${url}`);
  }
  if (!res.ok) {
    throw new WeatherError(`HTTP_${res.status}`, `HTTP ${res.status} (${url})`);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new WeatherError('BAD_JSON', `invalid JSON (${url})`);
  }
}

/**
 * Combine an optional external AbortSignal with a hard per-provider timeout
 * into a single signal. `dispose()` clears the timer and detaches listeners.
 */
function linkedSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) {
      ctrl.abort();
    } else {
      external.addEventListener('abort', onAbort, { once: true });
    }
  }
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  };
}

/* ------------------------------------------------------------------ *
 *  Condition mapping (provider codes -> normalised WeatherCondition)
 * ------------------------------------------------------------------ */

/** WMO weather_code (Open-Meteo). */
function wmoToCondition(code: number): WeatherCondition {
  if (code === 0) return 'clear';
  if (code === 1) return 'partly-cloudy';
  if (code === 2) return 'cloudy';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if (code >= 61 && code <= 63) return 'rain';
  if (code >= 65 && code <= 67) return 'heavy-rain';
  if (code === 71 || code === 73) return 'snow';
  if (code === 72 || code === 74) return 'heavy-snow';
  if (code === 75 || code === 77) return 'sleet';
  if (code >= 80 && code <= 82) return 'rain';
  if (code === 85 || code === 86) return 'heavy-snow';
  if (code >= 95) return 'thunderstorm';
  return 'cloudy';
}

/**
 * WeatherAPI.com condition code -> condition. Handles both code schemes
 * seen in the wild: the 3-digit WeatherAPI.com scheme (113=clear, 176=patchy
 * rain, 227=blizzard, ...) and the 4-digit Weatherstack-style scheme (1000+),
 * which some accounts return.
 */
function wsToCondition(code: number): WeatherCondition {
  if (code < 1000) {
    // 3-digit WeatherAPI.com scheme
    if (code === 113) return 'clear';
    if (code === 116) return 'partly-cloudy';
    if (code === 119) return 'cloudy';
    if (code === 122) return 'overcast';
    if (code === 143 || code === 248 || code === 260) return 'fog';
    if (code === 227) return 'heavy-snow';
    if (code === 179 || code === 200) return 'thunderstorm';
    if (code === 176 || (code >= 263 && code <= 266)) return 'drizzle';
    if (code === 185 || (code >= 281 && code <= 290)) return 'sleet';
    if (
      code === 182 ||
      (code >= 293 && code <= 302) ||
      (code >= 317 && code <= 320) ||
      (code >= 368 && code <= 383)
    ) {
      return 'snow';
    }
    if ((code >= 305 && code <= 314) || (code >= 329 && code <= 332)) return 'rain';
    if (code >= 323 && code <= 326) return 'sleet';
    if ((code >= 335 && code <= 365) || (code >= 386 && code <= 422)) return 'thunderstorm';
    return 'cloudy';
  }
  // 4-digit Weatherstack-style scheme
  if (code === 1030) return 'fog';
  if (code < 1006) return 'clear';
  if (code < 1009) return 'partly-cloudy';
  if (code < 2002) return 'cloudy';
  if (code < 3000) return 'drizzle';
  if (code < 4000) return 'rain';
  if (code < 5000) return code === 4018 ? 'heavy-snow' : 'snow';
  if (code < 6000) return code >= 5012 ? 'heavy-rain' : 'rain';
  if (code < 7000) return code >= 6016 ? 'sleet' : 'heavy-rain';
  if (code < 8000) return 'rain';
  return 'thunderstorm';
}

/** api.met.no symbol_code. */
function metNoSymbolToCondition(symbol: string): WeatherCondition {
  if (symbol.startsWith('clearsky') || symbol.startsWith('fair')) return 'clear';
  if (symbol.startsWith('partlycloudy')) return 'partly-cloudy';
  if (symbol.startsWith('cloudy')) return 'cloudy';
  if (symbol.startsWith('fog')) return 'fog';
  if (symbol.startsWith('thunderstorm')) return 'thunderstorm';
  if (symbol.startsWith('heavyrain')) return 'heavy-rain';
  if (symbol.startsWith('heavysnow') || symbol.startsWith('snowshowers_heavysnow')) {
    return 'heavy-snow';
  }
  if (symbol.startsWith('freezing') || symbol.startsWith('sleet')) return 'sleet';
  if (symbol.includes('snow_grains')) return 'sleet';
  if (symbol.startsWith('lightrain') || symbol.startsWith('lightdrizzle')) {
    return 'drizzle';
  }
  if (
    symbol.startsWith('lightsnow') ||
    symbol.startsWith('light_snow_grains') ||
    symbol.startsWith('snow')
  ) {
    return 'snow';
  }
  if (symbol.startsWith('rain')) return 'rain';
  if (symbol.includes('snow')) return 'snow';
  return 'cloudy';
}

const WIND_DIR_DEG: Record<string, number> = {
  N: 0, NNE: 22, NE: 45, ENE: 67, E: 90, ESE: 112, SE: 135, SSE: 157,
  S: 180, SSW: 202, SW: 225, WSW: 247, W: 270, WNW: 292, NW: 315, NNW: 337
};

function windDirToDeg(dir: string): number {
  return WIND_DIR_DEG[dir.toUpperCase()] ?? 0;
}

/* ------------------------------------------------------------------ *
 *  Provider 1 — Open-Meteo (keyless, up to 16 days)
 * ------------------------------------------------------------------ */

function buildOpenMeteoUrl(city: City): string {
  const p = new URLSearchParams({
    latitude: city.lat.toFixed(4),
    longitude: city.lon.toFixed(4),
    timezone: 'auto',
    forecast_days: '16',
    // NOTE: `time` must NOT be requested in the current list — the API
    // answers 400 when it is present (it is always returned in the response).
    current: [
      'temperature_2m',
      'relative_humidity_2m',
      'apparent_temperature',
      'precipitation',
      'weather_code',
      'cloud_cover',
      'wind_speed_10m',
      'wind_direction_10m',
      'pressure_msl'
    ].join(','),
    hourly:
      'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation_probability,cloud_cover',
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_probability_max',
      'wind_speed_10m_max',
      'precipitation_sum'
    ].join(',')
  });
  return `${OM_FORECAST_URL}?${p.toString()}`;
}

async function fetchOpenMeteo(
  city: City,
  signal: AbortSignal,
): Promise<WeatherSnapshot> {
  const raw = await httpJson<OpenMeteoForecastResponse>(buildOpenMeteoUrl(city), signal);
  const c = raw.current;
  if (!c) throw new WeatherError('OM_NO_CURRENT', 'open-meteo: missing current block');
  const curTime = c.time ?? new Date().toISOString().slice(0, 16);

  const curCond = wmoToCondition(c.weather_code);
  const current: CurrentWeather = {
    time: curTime,
    tempC: round1(c.temperature_2m),
    feelsLikeC: round1(c.apparent_temperature),
    condition: curCond,
    icon: conditionToIcon(curCond),
    humidityPct: Math.round(c.relative_humidity_2m),
    windKmh: Math.round(c.wind_speed_10m),
    windDirDeg: Math.round(c.wind_direction_10m),
    pressureHpa: Math.round(c.pressure_msl),
    precipMm: round1(c.precipitation),
    cloudCoverPct: Math.round(c.cloud_cover)
  };

  // Hourly strip: next 24 consecutive slots starting at the current hour.
  // (timezone=auto -> "YYYY-MM-DDTHH:MM" strings compare lexicographically)
  const times = raw.hourly.time;
  let start = 0;
  for (let i = 0; i < times.length; i++) {
    if (times[i] >= curTime) {
      start = i;
      break;
    }
  }
  const hourly: HourPoint[] = [];
  for (let i = start; i < times.length && hourly.length < 24; i++) {
    const cond = wmoToCondition(raw.hourly.weather_code[i] ?? 0);
    const prob = raw.hourly.precipitation_probability?.[i] ?? 0;
    hourly.push({
      time: times[i],
      tempC: Math.round(raw.hourly.temperature_2m[i] ?? 0),
      condition: cond,
      icon: conditionToIcon(cond),
      precipProbPct: Math.round(prob),
      windKmh: Math.round(raw.hourly.wind_speed_10m[i] ?? 0),
      cloudCoverPct: Math.round(raw.hourly.cloud_cover?.[i] ?? 0)
    });
  }

  const daily: DayPoint[] = [];
  const d = raw.daily;
  for (let i = 0; i < d.time.length && daily.length < 16; i++) {
    const cond = wmoToCondition(d.weather_code[i] ?? 0);
    const prob = d.precipitation_probability_max[i] ?? 0;
    const sum = d.precipitation_sum[i] ?? 0;
    daily.push({
      date: d.time[i],
      weekday: weekdayFromDate(d.time[i]),
      tempMaxC: Math.round(d.temperature_2m_max[i] ?? 0),
      tempMinC: Math.round(d.temperature_2m_min[i] ?? 0),
      condition: cond,
      icon: conditionToIcon(cond),
      precipProbPct: Math.round(prob),
      windKmh: Math.round(d.wind_speed_10m_max[i] ?? 0),
      precipMm: round1(sum)
    });
  }

  return {
    city,
    fetchedAt: new Date().toISOString(),
    source: 'open-meteo',
    current,
    hourly,
    daily
  };
}

/* ------------------------------------------------------------------ *
 *  Provider 2 — api.met.no / Yr.no (keyless, ~10 days)
 * ------------------------------------------------------------------ */

interface MetNoDayAcc {
  date: string;
  max: number;
  min: number;
  precip: number;
  prob: number;
  wind: number;
  symbol?: string;
}

function metNoSymbol(d: MetNoTimeseriesEntry['data']): string {
  return (
    d.next_6_hours?.summary?.symbol_code ??
    d.next_1_hours?.summary?.symbol_code ??
    'cloudy'
  );
}

async function fetchMetNo(
  city: City,
  signal: AbortSignal,
): Promise<WeatherSnapshot> {
  const url = `${MET_NO_URL}?lat=${city.lat.toFixed(4)}&lon=${city.lon.toFixed(4)}`;
  const raw = await httpJson<MetNoForecastResponse>(url, signal, {
    'User-Agent': MET_NO_USER_AGENT
  });

  const ts = raw.properties?.timeseries;
  if (!ts || ts.length === 0) {
    throw new WeatherError('MET_NO_EMPTY', 'met.no: empty timeseries');
  }

  const nowMs = Date.now();

  // Current = last entry at or before now. The compact API already resolves
  // the nearest grid point for the requested coordinates (times are UTC).
  let curIdx = 0;
  for (let i = 0; i < ts.length; i++) {
    if (Date.parse(ts[i].time) <= nowMs) curIdx = i;
    else break;
  }
  const cur = ts[curIdx].data;
  const curD = cur.instant.details;
  const curCond = metNoSymbolToCondition(metNoSymbol(cur));
  const current: CurrentWeather = {
    time: ts[curIdx].time,
    tempC: round1(curD.air_temperature ?? 0),
    feelsLikeC: round1(curD.air_temperature ?? 0), // met.no has no feels-like
    condition: curCond,
    icon: conditionToIcon(curCond),
    humidityPct: Math.round(curD.relative_humidity ?? 0),
    windKmh: Math.round((curD.wind_speed ?? 0) * 3.6),
    windDirDeg: Math.round(curD.wind_from_direction ?? 0),
    pressureHpa: Math.round(curD.air_pressure_at_sea_level ?? 1013),
    precipMm: round1(curD.precipitation_amount ?? 0),
    cloudCoverPct: Math.round(curD.cloud_area_fraction ?? 0)
  };

  // Hourly strip: consecutive entries within the next 24 h.
  const dayEndMs = nowMs + 24 * 3600 * 1000;
  const hourly: HourPoint[] = [];
  for (let i = curIdx; i < ts.length && hourly.length < 24; i++) {
    const t = ts[i].data;
    if (Date.parse(ts[i].time) > dayEndMs) break;
    const cond = metNoSymbolToCondition(metNoSymbol(t));
    const prob =
      t.next_6_hours?.details?.probability_of_precipitation ??
      t.next_1_hours?.details?.probability_of_precipitation ??
      0;
    hourly.push({
      time: ts[i].time,
      tempC: Math.round(t.instant.details.air_temperature ?? 0),
      condition: cond,
      icon: conditionToIcon(cond),
      precipProbPct: Math.round(prob),
      windKmh: Math.round((t.instant.details.wind_speed ?? 0) * 3.6),
      cloudCoverPct: Math.round(t.instant.details.cloud_area_fraction ?? 0)
    });
  }

  // Daily: aggregate entries per UTC date (up to 10 days).
  const acc = new Map<string, MetNoDayAcc>();
  for (const entry of ts) {
    const d = entry.data;
    const date = entry.time.slice(0, 10);
    const det = d.instant.details;
    const temp = det.air_temperature ?? 0;
    const wind = (det.wind_speed ?? 0) * 3.6;
    const existing = acc.get(date);
    if (!existing) {
      acc.set(date, {
        date,
        max: temp,
        min: temp,
        precip: det.precipitation_amount ?? 0,
        prob: 0,
        wind,
        symbol:
          d.next_6_hours?.summary?.symbol_code ??
          d.next_1_hours?.summary?.symbol_code
      });
    } else {
      existing.max = Math.max(existing.max, temp);
      existing.min = Math.min(existing.min, temp);
      existing.precip += det.precipitation_amount ?? 0;
      existing.prob = Math.max(
        existing.prob,
        d.next_6_hours?.details?.probability_of_precipitation ?? 0
      );
      existing.wind = Math.max(existing.wind, wind);
    }
  }

  const daily: DayPoint[] = [];
  for (const a of acc.values()) {
    if (daily.length >= 10) break;
    const cond = metNoSymbolToCondition(a.symbol ?? 'cloudy');
    daily.push({
      date: a.date,
      weekday: weekdayFromDate(a.date),
      tempMaxC: Math.round(a.max),
      tempMinC: Math.round(a.min),
      condition: cond,
      icon: conditionToIcon(cond),
      precipProbPct: Math.round(a.prob),
      windKmh: Math.round(a.wind),
      precipMm: round1(a.precip)
    });
  }

  return {
    city,
    fetchedAt: new Date().toISOString(),
    source: 'met-no',
    current,
    hourly,
    daily
  };
}

/* ------------------------------------------------------------------ *
 *  Provider 3 — WeatherAPI.com (keyed, up to 14 days)
 * ------------------------------------------------------------------ */

function buildWeatherApiUrl(city: City): string {
  const q = `${city.name}${city.admin ? ',' + city.admin : ''}`;
  return (
    `${WX_API_URL}?key=${encodeURIComponent(WEATHERAPI_KEY)}` +
    `&q=${encodeURIComponent(q)}&days=14&aqi=no&alerts=no`
  );
}

async function fetchWeatherApi(
  city: City,
  signal: AbortSignal,
): Promise<WeatherSnapshot> {
  const raw = await httpJson<WeatherApiResponse>(buildWeatherApiUrl(city), signal);
  const c = raw.current;
  if (!c) {
    throw new WeatherError('WXAPI_NO_CURRENT', 'weatherapi: missing current block');
  }

  const curCond = wsToCondition(c.condition?.code ?? 0);
  const current: CurrentWeather = {
    time: c.last_updated ?? new Date().toISOString(),
    tempC: round1(c.temp_c),
    feelsLikeC: round1(c.feelslike_c),
    condition: curCond,
    icon: conditionToIcon(curCond),
    humidityPct: Math.round(c.humidity),
    windKmh: Math.round(c.wind_kph),
    windDirDeg: windDirToDeg(c.wind_dir ?? ''),
    pressureHpa: Math.round(c.pressure_mb),
    precipMm: round1(c.precip_mm),
    cloudCoverPct: Math.round(c.cloud ?? 0),
    uvIndex: c.uv,
    visibilityKm: c.vis_km
  };

  const days = raw.forecast?.forecastday ?? [];
  if (days.length === 0) {
    throw new WeatherError('WXAPI_NO_FORECAST', 'weatherapi: empty forecast');
  }

  // Hourly strip: consecutive slots from the available forecast days.
  // WeatherAPI stamps look like "2026-08-20 19:00 ET" — compare first 16 chars.
  const nowStamp = (c.last_updated ?? '').slice(0, 16);
  const hourly: HourPoint[] = [];
  for (const day of days) {
    for (const s of day.hour ?? []) {
      if (hourly.length >= 24) break;
      if (nowStamp && s.time.slice(0, 16) < nowStamp) continue;
      const cond = wsToCondition(s.condition?.code ?? 0);
      hourly.push({
        time: s.time,
        tempC: Math.round(s.temp_c),
        condition: cond,
        icon: conditionToIcon(cond),
        precipProbPct: Math.round(Math.max(s.chance_of_rain ?? 0, s.chance_of_snow ?? 0)),
        windKmh: Math.round(s.wind_kph ?? 0),
        cloudCoverPct: Math.round(s.cloud ?? 0)
      });
    }
    if (hourly.length >= 24) break;
  }

  const daily: DayPoint[] = [];
  for (const day of days) {
    if (daily.length >= 14) break;
    const cond = wsToCondition(day.day?.condition?.code ?? 0);
    daily.push({
      date: day.date,
      weekday: weekdayFromDate(day.date),
      tempMaxC: Math.round(day.day?.maxtemp_c ?? 0),
      tempMinC: Math.round(day.day?.mintemp_c ?? 0),
      condition: cond,
      icon: conditionToIcon(cond),
      precipProbPct: Math.round(
        Math.max(day.day?.daily_chance_of_rain ?? 0, day.day?.daily_chance_of_snow ?? 0)
      ),
      windKmh: Math.round(day.day?.maxwind_kph ?? 0),
      precipMm: round1(day.day?.totalprecip_mm ?? 0)
    });
  }

  return {
    city,
    fetchedAt: new Date().toISOString(),
    source: 'weatherapi',
    current,
    hourly,
    daily
  };
}

/* ------------------------------------------------------------------ *
 *  Service implementation
 * ------------------------------------------------------------------ */

/** BigDataCloud reverse-geocode response (only fields we consume). */
interface BigDataCloudResponse {
  city?: string;
  locality?: string;
  principalSubdivision?: string;
  countryName?: string;
}

class WeatherServiceImpl implements WeatherService {
  /**
   * Search places by name (Open-Meteo geocoding, cached 24 h).
   * The API's fuzzy ranking puts obscure towns before major ones ("KRA" ->
   * Kerang, Australia), so we fetch 20 candidates and re-rank client-side:
   * prefix matches first, then same-country bias (the app's locale), then
   * population — "KRA" from Poland yields Kraków.
   */
  async searchCities(
    query: string,
    biasCountry?: string,
    signal?: AbortSignal
  ): Promise<City[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const cacheKey = `${CACHE_PREFIX}:geo:${hashId(q.toLowerCase())}:${biasCountry ?? 'none'}`;
    const cached = readCache<City[]>(cacheKey, GEO_CACHE_TTL_MS);
    if (cached) return cached;

    const url =
      `${GEOCODE_URL}?name=${encodeURIComponent(q)}` +
      '&count=20&language=pl&format=json';
    const raw = await httpJson<OpenMeteoGeocodeResponse>(
      url,
      signal ?? new AbortController().signal
    );
    const cities: City[] = (raw.results ?? []).map((r) => ({
      id: r.id != null ? String(r.id) : hashId(`${r.name}|${r.latitude},${r.longitude}`),
      name: r.name.toUpperCase(),
      country: (r.country ?? '').toUpperCase(),
      admin: r.admin1 ? r.admin1.toUpperCase() : undefined,
      lat: r.latitude,
      lon: r.longitude,
      population: r.population
    }));

    // Diacritic-insensitive normalisation ("Kraków" == "krakow").
    const norm = (s: string): string =>
      s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const nq = norm(q);
    const bias = (biasCountry ?? '').toUpperCase();
    const ranked = cities
      .map((c) => {
        let score = Math.log10(Math.max(100, c.population ?? 0));
        if (norm(c.name).startsWith(nq)) score += 2;
        if (bias && c.country === bias) score += 1.5;
        return { c, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);

    if (ranked.length > 0) writeCache(cacheKey, ranked);
    return ranked;
  }

  /**
   * Full snapshot for a place.
   * Order: local cache -> open-meteo -> met-no -> weatherapi.
   * Every provider gets a hard 3000 ms budget; failures fail over silently.
   */
  async getSnapshot(city: City, signal?: AbortSignal, forceRefresh = false): Promise<WeatherSnapshot> {
    const cacheKey = this.wxCacheKey(city);
    if (!forceRefresh) {
      const cached = readCache<WeatherSnapshot>(cacheKey, WX_CACHE_TTL_MS);
      if (cached) return cached;
    }

    const providers: Array<{
      id: Provider;
      run: (s: AbortSignal) => Promise<WeatherSnapshot>;
    }> = [
      { id: 'open-meteo', run: (s) => fetchOpenMeteo(city, s) },
      { id: 'met-no', run: (s) => fetchMetNo(city, s) }
    ];
    if (WEATHERAPI_KEY) {
      providers.push({ id: 'weatherapi', run: (s) => fetchWeatherApi(city, s) });
    }

    const failures: string[] = [];
    for (const p of providers) {
      if (signal?.aborted) throw new WeatherError('ABORTED');
      const linked = linkedSignal(signal, PROVIDER_TIMEOUT_MS);
      try {
        const snapshot = await p.run(linked.signal);
        writeCache(cacheKey, snapshot);
        return snapshot;
      } catch (err) {
        // User-initiated abort -> stop the cascade and propagate.
        if (signal?.aborted) {
          throw new WeatherError('ABORTED');
        }
        failures.push(`${p.id}: ${err instanceof Error ? err.message : String(err)}`);
        // otherwise: silent failover to the next provider
      } finally {
        linked.dispose();
      }
    }
    throw new WeatherError('ALL_PROVIDERS_FAILED', failures.join(' | '));
  }

  /** Reverse-geocode GPS coordinates into a City (BigDataCloud, cached 24 h). */
  async reverseGeocode(p: GeoPoint, signal?: AbortSignal): Promise<City> {
    const cacheKey = `${CACHE_PREFIX}:rev:${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
    const cached = readCache<City>(cacheKey, GEO_CACHE_TTL_MS);
    if (cached) return cached;

    const url =
      `${REVERSE_GEO_URL}?latitude=${p.lat}&longitude=${p.lon}` +
      '&localityLanguage=pl&postalCode=false&neighborhood=false';
    const raw = await httpJson<BigDataCloudResponse>(
      url,
      signal ?? new AbortController().signal
    );
    const city: City = {
      id: hashId(`${raw.city ?? raw.locality ?? 'gps'}|${p.lat.toFixed(3)},${p.lon.toFixed(3)}`),
      name: (raw.city ?? raw.locality ?? 'MOJE MIEJSCE').toUpperCase(),
      country: (raw.countryName ?? '').toUpperCase(),
      admin: raw.principalSubdivision ? raw.principalSubdivision.toUpperCase() : undefined,
      lat: p.lat,
      lon: p.lon
    };
    writeCache(cacheKey, city);
    return city;
  }

  /** Drop every nokia3310:* cache entry. */
  clearCache(): void {
    try {
      const doomed: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith(CACHE_PREFIX) || k.startsWith('pogoda3310:v2:') || k.startsWith('nokia3310:'))) doomed.push(k);
      }
      for (const k of doomed) localStorage.removeItem(k);
    } catch {
      /* storage unavailable — nothing to clear */
    }
  }

  private wxCacheKey(city: City): string {
    return `${CACHE_PREFIX}:wx:${city.lat.toFixed(4)},${city.lon.toFixed(4)}`;
  }
}

/** Singleton consumed by the UI / main bootstrap. */
export const weatherService: WeatherService = new WeatherServiceImpl();
