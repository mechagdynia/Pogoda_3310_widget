/**
 * NOKIA 3310 WEATHER RETRO — domain types & API contracts.
 *
 * This is the single source of truth for data shapes shared across:
 *  - weather_service (HTTP + caching)
 *  - speech_service (voice -> place)
 *  - terminal_ui (presentation state machine)
 *  - lcd_renderer / pixel_bitmaps (icon selection)
 */

/* ------------------------------------------------------------------ *
 *  Conditions & icons
 * ------------------------------------------------------------------ */

/**
 * Normalised weather condition. Every provider (Weatherstack / Open-Meteo)
 * is mapped onto this closed set, so the UI never sees provider-specific codes.
 */
export type WeatherCondition =
  | 'clear'        // sunny / clear sky
  | 'partly-cloudy'
  | 'cloudy'
  | 'overcast'
  | 'fog'          // mist / fog
  | 'drizzle'
  | 'rain'
  | 'heavy-rain'
  | 'thunderstorm'
  | 'snow'
  | 'heavy-snow'
  | 'sleet';       // freezing rain / sleet / snow grains

/**
 * Icon id consumed by the pixel-art engine (see graphics/pixel_bitmaps.ts).
 * One-to-many from condition -> icon is resolved in `conditionToIcon`.
 */
export type IconId =
  | 'sun'
  | 'suncloud'
  | 'moon'
  | 'mooncloud'
  | 'partcloud'
  | 'cloud'
  | 'fog'
  | 'rain'
  | 'thunder'
  | 'snow'
  | 'wind';

/** Map a normalised condition to the animated icon that should be drawn. */
export function conditionToIcon(c: WeatherCondition): IconId {
  switch (c) {
    case 'clear':
      return 'sun';
    case 'partly-cloudy':
      return 'partcloud';
    case 'cloudy':
    case 'overcast':
      return 'cloud';
    case 'fog':
      return 'fog';
    case 'drizzle':
    case 'rain':
    case 'heavy-rain':
      return 'rain';
    case 'thunderstorm':
      return 'thunder';
    case 'snow':
    case 'heavy-snow':
    case 'sleet':
      return 'snow';
  }
}

/** Human-readable LCD label in the selected app language. */
export function conditionLabel(c: WeatherCondition, language: 'pl' | 'en' = 'pl'): string {
  const labels: Record<WeatherCondition, [string, string]> = {
    clear: ['CZYSTO', 'CLEAR'],
    'partly-cloudy': ['CZ. CHMURY', 'PART CLOUD'],
    cloudy: ['POCHMURNIE', 'CLOUDY'],
    overcast: ['ZACHMURZONE', 'OVERCAST'],
    fog: ['MGŁA', 'FOG'],
    drizzle: ['MŻAWKA', 'DRIZZLE'],
    rain: ['DESZCZ', 'RAIN'],
    'heavy-rain': ['SILNY DESZCZ', 'HEAVY RAIN'],
    thunderstorm: ['BURZA', 'STORM'],
    snow: ['ŚNIEG', 'SNOW'],
    'heavy-snow': ['SILNY ŚNIEG', 'HEAVY SNOW'],
    sleet: ['DESZCZ ZE ŚN.', 'SLEET'],
  };
  return language === 'pl' ? labels[c][0] : labels[c][1];
}

/* ------------------------------------------------------------------ *
 *  Location
 * ------------------------------------------------------------------ */

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** A searchable / selectable place. */
export interface City {
  id: string;
  name: string;
  country: string;
  /** Optional admin subdivision (voivodeship / region). */
  admin?: string;
  lat: number;
  lon: number;
  population?: number;
}

/* ------------------------------------------------------------------ *
 *  Forecast fragments
 * ------------------------------------------------------------------ */

export interface CurrentWeather {
  time: string;            // ISO local
  tempC: number;
  feelsLikeC: number;
  condition: WeatherCondition;
  icon: IconId;
  humidityPct: number;
  windKmh: number;
  windDirDeg: number;
  pressureHpa: number;
  precipMm: number;
  cloudCoverPct: number;
  uvIndex?: number;
  visibilityKm?: number;
}

export interface HourPoint {
  time: string;            // ISO local
  tempC: number;
  condition: WeatherCondition;
  icon: IconId;
  precipProbPct: number;
  windKmh: number;
  /** Cloud cover for choosing the sunny/cloudy animation variant. */
  cloudCoverPct?: number;
  /** Cloud layers and visibility used for sunrise/sunset quality hints. */
  cloudLowPct?: number;
  cloudMidPct?: number;
  cloudHighPct?: number;
  visibilityKm?: number;
}

export interface DayPoint {
  date: string;            // YYYY-MM-DD
  /** Weekday index 0=Sun..6=Sat (local). */
  weekday: number;
  tempMaxC: number;
  tempMinC: number;
  condition: WeatherCondition;
  icon: IconId;
  precipProbPct: number;
  windKmh: number;
  /** Daily total precipitation in mm (when available). */
  precipMm: number;
  /** Local ISO sunrise/sunset used for correct day/night weather icons. */
  sunrise?: string;
  sunset?: string;
}

/* ------------------------------------------------------------------ *
 *  Aggregated snapshot (what the UI renders)
 * ------------------------------------------------------------------ */

export interface WeatherSnapshot {
  city: City;
  fetchedAt: string;       // ISO
  source: Provider;
  /** IANA timezone supplied by the weather provider, when available. */
  timezone?: string;
  current: CurrentWeather;
  /** Hourly for the current day, stepped every ~3h. */
  hourly: HourPoint[];
  /** Daily, up to 30 days (drives week / 2-week / month views). */
  daily: DayPoint[];
}

/* ------------------------------------------------------------------ *
 *  Raw provider payloads (kept narrow — only fields we consume)
 * ------------------------------------------------------------------ */

export interface OpenMeteoGeocodeResponse {
  results?: Array<{
    id?: number;
    name: string;
    country?: string;
    admin1?: string;
    latitude: number;
    longitude: number;
    population?: number;
  }>;
}

export interface OpenMeteoForecastResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  timezone_abbreviation?: string;
  current?: {
    time?: string;
    temperature_2m: number;
    relative_humidity_2m: number;
    apparent_temperature: number;
    precipitation: number;
    weather_code: number;
    cloud_cover: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    pressure_msl: number;
  };
  hourly: {
    time: string[];
    temperature_2m: number[];
    weather_code: number[];
    precipitation_probability?: (number | null)[];
    wind_speed_10m: number[];
    cloud_cover?: (number | null)[];
    cloud_cover_low?: (number | null)[];
    cloud_cover_mid?: (number | null)[];
    cloud_cover_high?: (number | null)[];
    visibility?: (number | null)[];
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
    wind_speed_10m_max: number[];
    precipitation_sum: (number | null)[];
    sunrise?: string[];
    sunset?: string[];
  };
}

/** api.met.no (Yr.no) — instant detail fields for one timeseries entry. */
export interface MetNoDetails {
  air_temperature?: number;
  air_pressure_at_sea_level?: number;
  relative_humidity?: number;
  wind_speed?: number;            // m/s
  wind_from_direction?: number;   // deg
  wind_gusts_speed?: number;
  cloud_area_fraction?: number;   // %
  precipitation_amount?: number;  // mm
}

/** api.met.no — symbol summary inside a next_X_hours block. */
export interface MetNoSummary {
  symbol_code: string;
}

/** api.met.no — one next_X_hours block (symbol + numeric details). */
export interface MetNoNextHours {
  summary?: MetNoSummary;
  details?: {
    precipitation_amount?: number; // mm
    probability_of_precipitation?: number; // %
  };
}

/** api.met.no — one timeseries entry (hourly, single grid point). */
export interface MetNoTimeseriesEntry {
  time: string; // ISO UTC, e.g. "2026-08-21T15:00:00Z"
  data: {
    instant: { details: MetNoDetails };
    next_1_hours?: MetNoNextHours;
    next_6_hours?: MetNoNextHours;
    next_12_hours?: MetNoNextHours;
  };
}

/** api.met.no — compact locationforecast/2.0 response (GeoJSON Feature). */
export interface MetNoForecastResponse {
  type?: string;
  geometry?: { type: string; coordinates: [number, number] }; // [lon, lat]
  properties: {
    meta?: { updated_at?: string; units?: Record<string, string> };
    timeseries: MetNoTimeseriesEntry[];
  };
}

/** WeatherAPI.com — condition block shared by current / day / hourly. */
export interface WeatherApiCondition {
  icon?: string;
  text: string;
  code: number;
}

/** WeatherAPI.com — one hourly slot inside forecastday[].hour. */
export interface WeatherApiHourly {
  time: string;
  temp_c: number;
  is_day?: number;
  condition?: WeatherApiCondition;
  precip_mm?: number;
  chance_of_rain?: number;
  chance_of_snow?: number;
  wind_kph?: number;
  cloud?: number;
}

/** WeatherAPI.com — one forecast day. */
export interface WeatherApiDay {
  date: string;
  day?: {
    condition?: WeatherApiCondition;
    maxtemp_c?: number;
    mintemp_c?: number;
    maxwind_kph?: number;
    totalprecip_mm?: number;
    daily_chance_of_rain?: number;
    daily_chance_of_snow?: number;
  };
  hour?: WeatherApiHourly[];
}

/** WeatherAPI.com — full forecast.json response (only fields we consume). */
export interface WeatherApiResponse {
  location: {
    name: string;
    region?: string;
    country: string;
    lat: number;
    lon: number;
    tz_id?: string;
  };
  current: {
    temp_c: number;
    feelslike_c: number;
    humidity: number;
    wind_kph: number;
    wind_dir?: string;   // e.g. "NNE"
    pressure_mb: number;
    cloud?: number;
    precip_mm: number;
    uv?: number;
    vis_km?: number;
    condition: WeatherApiCondition;
    last_updated?: string;
  };
  forecast: { forecastday: WeatherApiDay[] };
}

/* ------------------------------------------------------------------ *
 *  Service contracts
 * ------------------------------------------------------------------ */

/**
 * Weather provider ids, in cascade order:
 *  1. open-meteo  — primary, keyless, up to 16 days
 *  2. met-no      — Yr.no grid, keyless, ~10 days
 *  3. weatherapi  — WeatherAPI.com, key required, up to 14 days
 */
export type Provider = 'open-meteo' | 'met-no' | 'weatherapi';

export interface WeatherService {
  /** Search places by name (geocoding); biasCountry re-ranks same-country results higher. */
  searchCities(query: string, biasCountry?: string, signal?: AbortSignal): Promise<City[]>;
  /** Full snapshot for a place (with caching + fallback). */
  getSnapshot(city: City, signal?: AbortSignal, forceRefresh?: boolean): Promise<WeatherSnapshot>;
  /** Reverse-geocode GPS coordinates into a City. */
  reverseGeocode(p: GeoPoint, signal?: AbortSignal): Promise<City>;
  /** Clear all cached weather. */
  clearCache(): void;
}

/* ------------------------------------------------------------------ *
 *  UI / navigation contracts
 * ------------------------------------------------------------------ */

export type TabId = 'today' | 'week' | 'twoweeks' | 'month';

export interface TabDef {
  id: TabId;
  /** Short label drawn on the tab bar / softkeys. */
  label: string;
}

export const TABS: TabDef[] = [
  { id: 'today', label: 'DZIŚ' },
  { id: 'week', label: 'TYDZIEŃ' },
  { id: 'twoweeks', label: '2 TYG.' },
  { id: 'month', label: 'MIESIĄC' }
];

/** Logical key events the UI understands (softkeys, keyboard, tap, swipe). */
export type Key =
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT'
  | 'OK'
  | 'BACK'
  | 'MENU'
  | 'DEL'
  | 'SOFTL'
  | 'SOFT';

/** Character entered (from multi-tap keypad or physical keyboard). */
export interface CharInput {
  ch: string;
}

export type UiEvent = Key | CharInput;
