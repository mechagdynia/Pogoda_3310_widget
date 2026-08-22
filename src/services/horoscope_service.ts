import type { AppLanguage } from '../i18n';

export type ZodiacSign =
  | 'aries' | 'taurus' | 'gemini' | 'cancer' | 'leo' | 'virgo'
  | 'libra' | 'scorpio' | 'sagittarius' | 'capricorn' | 'aquarius' | 'pisces';

export interface ZodiacDefinition {
  id: ZodiacSign;
  icon: string;
  pl: string;
  en: string;
  from: string;
  to: string;
}

export const ZODIAC: ZodiacDefinition[] = [
  { id: 'aries', icon: '♈', pl: 'Baran', en: 'Aries', from: '21.03', to: '19.04' },
  { id: 'taurus', icon: '♉', pl: 'Byk', en: 'Taurus', from: '20.04', to: '20.05' },
  { id: 'gemini', icon: '♊', pl: 'Bliźnięta', en: 'Gemini', from: '21.05', to: '20.06' },
  { id: 'cancer', icon: '♋', pl: 'Rak', en: 'Cancer', from: '21.06', to: '22.07' },
  { id: 'leo', icon: '♌', pl: 'Lew', en: 'Leo', from: '23.07', to: '22.08' },
  { id: 'virgo', icon: '♍', pl: 'Panna', en: 'Virgo', from: '23.08', to: '22.09' },
  { id: 'libra', icon: '♎', pl: 'Waga', en: 'Libra', from: '23.09', to: '22.10' },
  { id: 'scorpio', icon: '♏', pl: 'Skorpion', en: 'Scorpio', from: '23.10', to: '21.11' },
  { id: 'sagittarius', icon: '♐', pl: 'Strzelec', en: 'Sagittarius', from: '22.11', to: '21.12' },
  { id: 'capricorn', icon: '♑', pl: 'Koziorożec', en: 'Capricorn', from: '22.12', to: '19.01' },
  { id: 'aquarius', icon: '♒', pl: 'Wodnik', en: 'Aquarius', from: '20.01', to: '18.02' },
  { id: 'pisces', icon: '♓', pl: 'Ryby', en: 'Pisces', from: '19.02', to: '20.03' },
];

interface HoroscopeEntry { en: string; pl: string }
interface HoroscopeDataset {
  date: string;
  generatedAt: string;
  source: string;
  signs: Record<ZodiacSign, HoroscopeEntry>;
}

export interface HoroscopeResult {
  date: string;
  text: string;
  sign: ZodiacDefinition;
  source: string;
  stale: boolean;
}

const CACHE_KEY = 'pogoda3310:horoscopes:v1';

export function zodiacForDate(date = new Date()): ZodiacDefinition {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const edge = month * 100 + day;
  let sign: ZodiacSign = 'capricorn';
  if (edge >= 120 && edge <= 218) sign = 'aquarius';
  else if (edge >= 219 && edge <= 320) sign = 'pisces';
  else if (edge >= 321 && edge <= 419) sign = 'aries';
  else if (edge >= 420 && edge <= 520) sign = 'taurus';
  else if (edge >= 521 && edge <= 620) sign = 'gemini';
  else if (edge >= 621 && edge <= 722) sign = 'cancer';
  else if (edge >= 723 && edge <= 822) sign = 'leo';
  else if (edge >= 823 && edge <= 922) sign = 'virgo';
  else if (edge >= 923 && edge <= 1022) sign = 'libra';
  else if (edge >= 1023 && edge <= 1121) sign = 'scorpio';
  else if (edge >= 1122 && edge <= 1221) sign = 'sagittarius';
  return ZODIAC.find((item) => item.id === sign) ?? ZODIAC[0];
}

export function zodiacLabel(sign: ZodiacDefinition, language: AppLanguage): string {
  return language === 'pl' ? sign.pl : sign.en;
}

export function zodiacDateRange(sign: ZodiacDefinition, language: AppLanguage): string {
  if (language === 'pl') return `od ${sign.from} do ${sign.to}`;
  const englishDate = (value: string): string => {
    const [day, month] = value.split('.').map(Number);
    return new Date(Date.UTC(2024, month - 1, day)).toLocaleDateString('en-GB', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  };
  return `${englishDate(sign.from)} – ${englishDate(sign.to)}`;
}

function isDataset(value: unknown): value is HoroscopeDataset {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<HoroscopeDataset>;
  return typeof data.date === 'string' && typeof data.generatedAt === 'string' && !!data.signs;
}

async function loadDataset(signal?: AbortSignal): Promise<HoroscopeDataset> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const url = new URL(`data/horoscopes.json?day=${today}`, document.baseURI);
    const response = await fetch(url, { signal, cache: 'no-cache' });
    if (!response.ok) throw new Error(`HOROSCOPE_DATA_${response.status}`);
    const dataset = await response.json() as unknown;
    if (!isDataset(dataset)) throw new Error('HOROSCOPE_DATA_INVALID');
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(dataset)); } catch { /* no-op */ }
    return dataset;
  } catch (error) {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '') as unknown;
      if (isDataset(cached)) return cached;
    } catch { /* no cached dataset */ }
    throw error;
  }
}

export async function getHoroscope(signId: ZodiacSign, language: AppLanguage, signal?: AbortSignal): Promise<HoroscopeResult> {
  const dataset = await loadDataset(signal);
  const sign = ZODIAC.find((item) => item.id === signId) ?? zodiacForDate();
  const entry = dataset.signs[sign.id];
  if (!entry) throw new Error('HOROSCOPE_SIGN_MISSING');
  const today = new Date().toISOString().slice(0, 10);
  return {
    date: dataset.date,
    text: language === 'pl' ? (entry.pl || entry.en) : entry.en,
    sign,
    source: dataset.source,
    stale: dataset.date !== today,
  };
}
