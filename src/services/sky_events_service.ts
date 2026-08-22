import {
  AngleBetween,
  Body,
  Equator,
  GeoVector,
  Horizon,
  Illumination,
  NextLunarEclipse,
  Observer,
  SearchLocalSolarEclipse,
  SearchLunarEclipse,
} from 'astronomy-engine';
import type { AppLanguage } from '../i18n';
import { localeFor, tx } from '../i18n';
import type { HourPoint, WeatherSnapshot } from '../types/weather';

const AU_KM = 149_597_870.7;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

interface PlanetDefinition {
  body: Body;
  pl: string;
  en: string;
  icon: string;
}

const PLANETS: PlanetDefinition[] = [
  { body: Body.Mercury, pl: 'Merkury', en: 'Mercury', icon: '☿' },
  { body: Body.Venus, pl: 'Wenus', en: 'Venus', icon: '♀' },
  { body: Body.Mars, pl: 'Mars', en: 'Mars', icon: '♂' },
  { body: Body.Jupiter, pl: 'Jowisz', en: 'Jupiter', icon: '♃' },
  { body: Body.Saturn, pl: 'Saturn', en: 'Saturn', icon: '♄' },
];

const BODY_LABELS: Record<string, [string, string]> = {
  [Body.Moon]: ['Księżyc', 'Moon'],
  ...Object.fromEntries(PLANETS.map((planet) => [planet.body, [planet.pl, planet.en]])),
};

export interface TwilightHighlight {
  kind: 'sunrise' | 'sunset';
  icon: string;
  dayLabel: string;
  timeLabel: string;
  title: string;
  reason: string;
  score: number;
}

export interface PlanetVisibilityFact {
  icon: string;
  name: string;
  bestTime: Date;
  altitudeDeg: number;
  azimuthDeg: number;
  distanceAu: number;
  distanceMillionKm: number;
  magnitude: number;
}

export interface SkyEventFact {
  icon: string;
  title: string;
  detail: string;
  time?: Date;
}

function parseLocalMinutes(value: string): number {
  const match = value.match(/T(\d{2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

function closestHour(hours: HourPoint[], eventTime: string): HourPoint | undefined {
  const day = eventTime.slice(0, 10);
  const target = parseLocalMinutes(eventTime);
  return hours
    .filter((hour) => hour.time.slice(0, 10) === day)
    .reduce<HourPoint | undefined>((best, hour) => {
      if (!best) return hour;
      return Math.abs(parseLocalMinutes(hour.time) - target) < Math.abs(parseLocalMinutes(best.time) - target) ? hour : best;
    }, undefined);
}

function twilightReason(hour: HourPoint | undefined, language: AppLanguage): { score: number; reason: string } {
  if (!hour) return { score: 4, reason: tx(language, 'Brakuje części danych warstwowych, więc warto po prostu zerknąć na horyzont.', 'Some cloud-layer data is missing, so it is still worth checking the horizon.') };
  const low = hour.cloudLowPct ?? hour.cloudCoverPct ?? 50;
  const mid = hour.cloudMidPct ?? hour.cloudCoverPct ?? 50;
  const high = hour.cloudHighPct ?? hour.cloudCoverPct ?? 50;
  const visibility = hour.visibilityKm;
  let score = 0;
  const reasons: string[] = [];
  if (low <= 35) {
    score += 3;
    reasons.push(tx(language, 'mało niskich chmur przy horyzoncie', 'few low clouds near the horizon'));
  }
  if ((mid >= 15 && mid <= 75) || (high >= 15 && high <= 80)) {
    score += 3;
    reasons.push(tx(language, 'średnie lub wysokie chmury mogą złapać kolory', 'mid or high clouds may catch the colours'));
  }
  if (hour.precipProbPct < 25) {
    score += 2;
    reasons.push(tx(language, 'małe ryzyko opadów', 'low rain risk'));
  }
  if (visibility != null && visibility >= 10) {
    score += 1;
    reasons.push(tx(language, 'dobra widzialność', 'good visibility'));
  }
  if (reasons.length === 0) reasons.push(tx(language, 'układ chmur może zmienić się lokalnie tuż przed zjawiskiem', 'the cloud pattern may still change locally just before the event'));
  return { score, reason: reasons.join(', ') };
}

export function twilightHighlights(snapshot: WeatherSnapshot, language: AppLanguage): TwilightHighlight[] {
  return snapshot.daily.slice(0, 2).flatMap((day, dayIndex) => {
    const dayLabel = dayIndex === 0 ? tx(language, 'dzisiaj', 'today') : tx(language, 'jutro', 'tomorrow');
    return ([['sunrise', day.sunrise], ['sunset', day.sunset]] as const).flatMap(([kind, time]) => {
      if (!time) return [];
      const quality = twilightReason(closestHour(snapshot.hourly, time), language);
      const eventName = kind === 'sunrise' ? tx(language, 'wschód Słońca', 'sunrise') : tx(language, 'zachód Słońca', 'sunset');
      const title = quality.score >= 7
        ? tx(language, `Duża szansa na piękny ${eventName}`, `Good chance of a beautiful ${eventName}`)
        : quality.score >= 5
          ? tx(language, `Obiecujący ${eventName}`, `Promising ${eventName}`)
          : tx(language, `Warto zerknąć na ${eventName}`, `Worth checking the ${eventName}`);
      return [{
        kind,
        icon: kind === 'sunrise' ? '◒↑' : '◒↓',
        dayLabel,
        timeLabel: time.slice(11, 16),
        title,
        reason: `${quality.reason}.`,
        score: quality.score,
      } satisfies TwilightHighlight];
    });
  });
}

function altitude(body: Body, date: Date, observer: Observer): { altitude: number; azimuth: number } {
  const equatorial = Equator(body, date, observer, true, true);
  const horizontal = Horizon(date, observer, equatorial.ra, equatorial.dec, 'normal');
  return { altitude: horizontal.altitude, azimuth: horizontal.azimuth };
}

export function visiblePlanetFacts(snapshot: WeatherSnapshot, language: AppLanguage, from = new Date()): PlanetVisibilityFact[] {
  const observer = new Observer(snapshot.city.lat, snapshot.city.lon, 0);
  const facts: PlanetVisibilityFact[] = [];
  for (const planet of PLANETS) {
    let bestTime: Date | null = null;
    let bestAltitude = -90;
    let bestAzimuth = 0;
    for (let step = 0; step <= 96; step++) {
      const date = new Date(from.getTime() + step * 15 * 60_000);
      const sunAltitude = altitude(Body.Sun, date, observer).altitude;
      const position = altitude(planet.body, date, observer);
      if (sunAltitude <= -6 && position.altitude > bestAltitude) {
        bestTime = date;
        bestAltitude = position.altitude;
        bestAzimuth = position.azimuth;
      }
    }
    if (!bestTime || bestAltitude < 8) continue;
    const illumination = Illumination(planet.body, bestTime);
    facts.push({
      icon: planet.icon,
      name: language === 'pl' ? planet.pl : planet.en,
      bestTime,
      altitudeDeg: bestAltitude,
      azimuthDeg: bestAzimuth,
      distanceAu: illumination.geo_dist,
      distanceMillionKm: illumination.geo_dist * AU_KM / 1_000_000,
      magnitude: illumination.mag,
    });
  }
  return facts.sort((a, b) => a.distanceAu - b.distanceAu);
}

function bodyLabel(body: Body, language: AppLanguage): string {
  const labels = BODY_LABELS[body] ?? [body, body];
  return language === 'pl' ? labels[0] : labels[1];
}

function formatEventTime(date: Date, snapshot: WeatherSnapshot, language: AppLanguage): string {
  return date.toLocaleString(localeFor(language), {
    timeZone: snapshot.timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function conjunctionEvent(snapshot: WeatherSnapshot, language: AppLanguage, from: Date): SkyEventFact | null {
  const observer = new Observer(snapshot.city.lat, snapshot.city.lon, 0);
  const bodies = [Body.Moon, ...PLANETS.map((planet) => planet.body)];
  let best: { first: Body; second: Body; angle: number; date: Date } | null = null;
  for (let firstIndex = 0; firstIndex < bodies.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < bodies.length; secondIndex++) {
      for (let step = 0; step <= 84; step++) {
        const date = new Date(from.getTime() + step * 2 * HOUR_MS);
        if (altitude(Body.Sun, date, observer).altitude > -4) continue;
        const firstAltitude = altitude(bodies[firstIndex], date, observer).altitude;
        const secondAltitude = altitude(bodies[secondIndex], date, observer).altitude;
        if (firstAltitude < 8 || secondAltitude < 8) continue;
        const angle = AngleBetween(GeoVector(bodies[firstIndex], date, true), GeoVector(bodies[secondIndex], date, true));
        if (!best || angle < best.angle) best = { first: bodies[firstIndex], second: bodies[secondIndex], angle, date };
      }
    }
  }
  if (!best || best.angle > 5) return null;
  const names = `${bodyLabel(best.first, language)} + ${bodyLabel(best.second, language)}`;
  return {
    icon: '⋆',
    title: tx(language, `Bliskie spotkanie: ${names}`, `Close pairing: ${names}`),
    detail: tx(language, `Około ${best.angle.toFixed(1)}° od siebie; najlepiej patrzeć ${formatEventTime(best.date, snapshot, language)}.`, `About ${best.angle.toFixed(1)}° apart; best viewed ${formatEventTime(best.date, snapshot, language)}.`),
    time: best.date,
  };
}

interface ShowerDefinition {
  pl: string;
  en: string;
  start: [number, number];
  peak: [number, number];
  end: [number, number];
}

const METEOR_SHOWERS: ShowerDefinition[] = [
  { pl: 'Kwadrantydy', en: 'Quadrantids', start: [12, 28], peak: [1, 3], end: [1, 12] },
  { pl: 'Lirydy', en: 'Lyrids', start: [4, 14], peak: [4, 22], end: [4, 30] },
  { pl: 'Eta Akwarydy', en: 'Eta Aquariids', start: [4, 19], peak: [5, 6], end: [5, 28] },
  { pl: 'Południowe delta Akwarydy', en: 'Southern delta Aquariids', start: [7, 12], peak: [7, 30], end: [8, 23] },
  { pl: 'Perseidy', en: 'Perseids', start: [7, 17], peak: [8, 12], end: [8, 24] },
  { pl: 'Orionidy', en: 'Orionids', start: [10, 2], peak: [10, 21], end: [11, 7] },
  { pl: 'Leonidy', en: 'Leonids', start: [11, 6], peak: [11, 17], end: [11, 30] },
  { pl: 'Geminidy', en: 'Geminids', start: [12, 4], peak: [12, 14], end: [12, 20] },
  { pl: 'Ursydy', en: 'Ursids', start: [12, 17], peak: [12, 22], end: [12, 26] },
];

function showerDates(shower: ShowerDefinition, peakYear: number): { start: Date; peak: Date; end: Date } {
  const startYear = shower.start[0] > shower.peak[0] ? peakYear - 1 : peakYear;
  const endYear = shower.end[0] < shower.peak[0] ? peakYear + 1 : peakYear;
  return {
    start: new Date(Date.UTC(startYear, shower.start[0] - 1, shower.start[1])),
    peak: new Date(Date.UTC(peakYear, shower.peak[0] - 1, shower.peak[1], 1)),
    end: new Date(Date.UTC(endYear, shower.end[0] - 1, shower.end[1], 23, 59)),
  };
}

function meteorEvents(snapshot: WeatherSnapshot, language: AppLanguage, from: Date): SkyEventFact[] {
  const events: SkyEventFact[] = [];
  for (const shower of METEOR_SHOWERS) {
    for (const year of [from.getUTCFullYear() - 1, from.getUTCFullYear(), from.getUTCFullYear() + 1]) {
      const dates = showerDates(shower, year);
      const name = language === 'pl' ? shower.pl : shower.en;
      if (from >= dates.start && from <= dates.end) {
        const peakPassed = from > dates.peak;
        events.push({
          icon: '☄',
          title: tx(language, `Aktywny rój: ${name}`, `Active shower: ${name}`),
          detail: peakPassed
            ? tx(language, `Maksimum już minęło, ale pojedyncze meteory są nadal możliwe do ${formatEventTime(dates.end, snapshot, language)}.`, `The peak has passed, but individual meteors remain possible until ${formatEventTime(dates.end, snapshot, language)}.`)
            : tx(language, `Maksimum około ${formatEventTime(dates.peak, snapshot, language)}; najlepiej obserwować z ciemnego miejsca.`, `Peak around ${formatEventTime(dates.peak, snapshot, language)}; a dark location gives the best view.`),
          time: dates.peak,
        });
        break;
      }
    }
  }
  return events.slice(0, 2);
}

function eclipseEvents(snapshot: WeatherSnapshot, language: AppLanguage, from: Date): SkyEventFact[] {
  const observer = new Observer(snapshot.city.lat, snapshot.city.lon, 0);
  const events: SkyEventFact[] = [];
  const solar = SearchLocalSolarEclipse(from, observer);
  const solarDate = solar.peak.time.date;
  if (solar.peak.altitude > 0 && solarDate.getTime() - from.getTime() <= 730 * DAY_MS) {
    events.push({
      icon: '◉',
      title: tx(language, 'Najbliższe lokalne zaćmienie Słońca', 'Next local solar eclipse'),
      detail: tx(language, `${formatEventTime(solarDate, snapshot, language)} · zasłonięcie około ${Math.round(solar.obscuration * 100)}% tarczy.`, `${formatEventTime(solarDate, snapshot, language)} · about ${Math.round(solar.obscuration * 100)}% of the disc obscured.`),
      time: solarDate,
    });
  }

  let lunar = SearchLunarEclipse(from);
  for (let attempt = 0; attempt < 4; attempt++) {
    const date = lunar.peak.date;
    if (date.getTime() - from.getTime() > 730 * DAY_MS) break;
    if (altitude(Body.Moon, date, observer).altitude > 3) {
      events.push({
        icon: '◐',
        title: tx(language, 'Najbliższe widoczne zaćmienie Księżyca', 'Next visible lunar eclipse'),
        detail: tx(language, `${formatEventTime(date, snapshot, language)} · maksimum zasłonięcia ${Math.round(lunar.obscuration * 100)}%.`, `${formatEventTime(date, snapshot, language)} · peak obscuration ${Math.round(lunar.obscuration * 100)}%.`),
        time: date,
      });
      break;
    }
    lunar = NextLunarEclipse(lunar.peak);
  }
  return events;
}

let eventCacheKey = '';
let eventCache: SkyEventFact[] = [];

export function astronomyEvents(snapshot: WeatherSnapshot, language: AppLanguage, from = new Date()): SkyEventFact[] {
  const key = `${snapshot.city.lat.toFixed(3)}:${snapshot.city.lon.toFixed(3)}:${from.toISOString().slice(0, 10)}:${language}`;
  if (key === eventCacheKey) return eventCache;
  const conjunction = conjunctionEvent(snapshot, language, from);
  eventCache = [
    ...meteorEvents(snapshot, language, from),
    ...(conjunction ? [conjunction] : []),
    ...eclipseEvents(snapshot, language, from),
  ];
  eventCacheKey = key;
  return eventCache;
}

export function formatPlanetBestTime(fact: PlanetVisibilityFact, snapshot: WeatherSnapshot, language: AppLanguage): string {
  return fact.bestTime.toLocaleTimeString(localeFor(language), {
    timeZone: snapshot.timezone,
    hour: '2-digit',
    minute: '2-digit',
  });
}
