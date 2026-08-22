import type { AppLanguage } from '../i18n';
import { tx } from '../i18n';
import type { DayPoint } from '../types/weather';

const SYNODIC_MONTH_DAYS = 29.530588853;
const DAY_MS = 86_400_000;
const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14);
const AURORA_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';
const AURORA_CACHE_KEY = 'pogoda3310:aurora:v1';
const AURORA_CACHE_MS = 30 * 60 * 1000;

export type MoonPhaseId =
  | 'new'
  | 'waxing-crescent'
  | 'first-quarter'
  | 'waxing-gibbous'
  | 'full'
  | 'waning-gibbous'
  | 'last-quarter'
  | 'waning-crescent';

export interface MoonInfo {
  date: Date;
  phase: MoonPhaseId;
  fraction: number;
  illuminationPct: number;
  ageDays: number;
}

export interface AuroraForecast {
  fetchedAt: string;
  maxKp: number;
  peakTime: string;
  horizonEnd: string;
  forecastPoints: number;
  noaaScale: string | null;
}

interface KpRow {
  time_tag?: string;
  kp?: number | string;
  observed?: string;
  noaa_scale?: string | null;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

export function moonInfo(date = new Date()): MoonInfo {
  const days = (date.getTime() - NEW_MOON_EPOCH) / DAY_MS;
  const fraction = positiveModulo(days, SYNODIC_MONTH_DAYS) / SYNODIC_MONTH_DAYS;
  const phaseIndex = Math.floor(fraction * 8 + 0.5) % 8;
  const phases: MoonPhaseId[] = [
    'new', 'waxing-crescent', 'first-quarter', 'waxing-gibbous',
    'full', 'waning-gibbous', 'last-quarter', 'waning-crescent',
  ];
  return {
    date,
    phase: phases[phaseIndex],
    fraction,
    illuminationPct: Math.round((1 - Math.cos(2 * Math.PI * fraction)) * 50),
    ageDays: fraction * SYNODIC_MONTH_DAYS,
  };
}

export function moonPhaseLabel(phase: MoonPhaseId, language: AppLanguage): string {
  const labels: Record<MoonPhaseId, [string, string]> = {
    new: ['Nów', 'New Moon'],
    'waxing-crescent': ['Przybywający sierp', 'Waxing crescent'],
    'first-quarter': ['Pierwsza kwadra', 'First quarter'],
    'waxing-gibbous': ['Przybywający garb', 'Waxing gibbous'],
    full: ['Pełnia', 'Full Moon'],
    'waning-gibbous': ['Ubywający garb', 'Waning gibbous'],
    'last-quarter': ['Ostatnia kwadra', 'Last quarter'],
    'waning-crescent': ['Ubywający sierp', 'Waning crescent'],
  };
  return tx(language, labels[phase][0], labels[phase][1]);
}

export function nextFullMoon(from = new Date()): Date {
  const elapsedDays = (from.getTime() - NEW_MOON_EPOCH) / DAY_MS;
  let cycle = Math.floor(elapsedDays / SYNODIC_MONTH_DAYS);
  let full = NEW_MOON_EPOCH + (cycle + 0.5) * SYNODIC_MONTH_DAYS * DAY_MS;
  if (full <= from.getTime()) {
    cycle += 1;
    full = NEW_MOON_EPOCH + (cycle + 0.5) * SYNODIC_MONTH_DAYS * DAY_MS;
  }
  return new Date(full);
}

export function moonWeek(from = new Date()): MoonInfo[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(from);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + index);
    return moonInfo(date);
  });
}

export function isNightTime(iso: string, daily: DayPoint[] = []): boolean {
  const localStamp = iso.replace(' ', 'T').slice(0, 16);
  const date = localStamp.slice(0, 10);
  const day = daily.find((item) => item.date === date);
  if (day?.sunrise && day?.sunset) return localStamp < day.sunrise || localStamp >= day.sunset;
  const match = localStamp.match(/T(\d{2})/);
  const hour = match ? Number(match[1]) : 12;
  return hour < 6 || hour >= 20;
}

export function auroraKpThreshold(latitude: number): number {
  const lat = Math.abs(latitude);
  if (lat >= 67) return 3;
  if (lat >= 63) return 4;
  if (lat >= 58) return 5;
  if (lat >= 52) return 6;
  if (lat >= 48) return 7;
  return 8;
}

function readAuroraCache(): AuroraForecast | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(AURORA_CACHE_KEY) ?? '') as AuroraForecast;
    if (Date.now() - Date.parse(parsed.fetchedAt) < AURORA_CACHE_MS) return parsed;
  } catch { /* missing or invalid cache */ }
  return null;
}

export async function fetchAuroraForecast(signal?: AbortSignal): Promise<AuroraForecast> {
  const cached = readAuroraCache();
  if (cached) return cached;
  const response = await fetch(AURORA_URL, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`NOAA_KP_${response.status}`);
  const rows = await response.json() as KpRow[];
  const future = rows.filter((row) => row.time_tag && row.observed !== 'observed' && Number.isFinite(Number(row.kp)));
  if (future.length === 0) throw new Error('NOAA_KP_EMPTY');
  const peak = future.reduce((best, row) => Number(row.kp) > Number(best.kp) ? row : best);
  const result: AuroraForecast = {
    fetchedAt: new Date().toISOString(),
    maxKp: Number(peak.kp),
    peakTime: peak.time_tag ?? '',
    horizonEnd: future[future.length - 1]?.time_tag ?? '',
    forecastPoints: future.length,
    noaaScale: peak.noaa_scale ?? null,
  };
  try { localStorage.setItem(AURORA_CACHE_KEY, JSON.stringify(result)); } catch { /* no-op */ }
  return result;
}
