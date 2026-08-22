import type { WeatherSnapshot } from '../types/weather';

const LAST_SNAPSHOT_KEY = 'pogoda3310:last-successful-snapshot';

export function readLastSnapshot(): WeatherSnapshot | null {
  try {
    const raw = localStorage.getItem(LAST_SNAPSHOT_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw) as WeatherSnapshot;
    if (!snapshot?.city || !snapshot?.current || !Array.isArray(snapshot.hourly) || !Array.isArray(snapshot.daily)) return null;
    return snapshot;
  } catch {
    return null;
  }
}

export function writeLastSnapshot(snapshot: WeatherSnapshot): void {
  try {
    localStorage.setItem(LAST_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Private/embedded web views may disable persistent storage.
  }
}
