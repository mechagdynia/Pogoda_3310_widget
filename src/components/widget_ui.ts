import { WEATHER_ICONS } from '../graphics/pixel_bitmaps';
import type { LcdRenderer } from '../graphics/lcd_renderer';
import { DEFAULT_CITY } from '../services/weather_service';
import { readLastSnapshot, writeLastSnapshot } from '../services/weather_storage';
import type { City, HourPoint, IconId, WeatherService, WeatherSnapshot } from '../types/weather';
import { conditionLabel } from '../types/weather';

const CITY_KEY = 'pogoda3310:selected-city';
const LIVE_REFRESH_MS = 15 * 60 * 1000;
const WAKE_DEBOUNCE_MS = 5000;

const TINY_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '-': ['000', '000', '111', '000', '000'],
  '+': ['000', '010', '111', '010', '000'],
  '°': ['11', '11', '00', '00', '00'],
};

interface WidgetOptions { autoLoad?: boolean }

function storedCity(): City {
  try {
    const raw = localStorage.getItem(CITY_KEY);
    if (raw) return JSON.parse(raw) as City;
  } catch { /* embedded web views may block storage */ }
  return DEFAULT_CITY;
}

function hourLabel(iso: string): string {
  const match = iso.match(/T(\d{2})/);
  return match ? match[1] : '--';
}

function roundTemp(value: number): string {
  const n = Math.round(value);
  return `${n > 0 ? '+' : ''}${n}°`;
}

function tinyWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += (TINY_GLYPHS[ch]?.[0].length ?? 3) + 1;
  return Math.max(0, width - 1);
}

function tinyTextAt(lcd: LcdRenderer, startX: number, y: number, text: string): void {
  let x = startX;
  for (const ch of text) {
    const glyph = TINY_GLYPHS[ch];
    if (!glyph) { x += 4; continue; }
    for (let row = 0; row < glyph.length; row++) {
      for (let col = 0; col < glyph[row].length; col++) {
        if (glyph[row][col] === '1') lcd.setPixel(x + col, y + row);
      }
    }
    x += glyph[0].length + 1;
  }
}

function tinyTextRight(lcd: LcdRenderer, rightX: number, y: number, text: string): void {
  tinyTextAt(lcd, rightX - tinyWidth(text) + 1, y, text);
}

export class WidgetUI {
  private snapshot: WeatherSnapshot | null = readLastSnapshot();
  private city: City = this.snapshot?.city ?? storedCity();
  private loading = false;
  private error = '';
  private animTime = 0;
  private lastFrame = 0;
  private raf = 0;
  private disposed = false;
  private loadGeneration = 0;
  private offline = !navigator.onLine;
  private refreshTimer = 0;
  private lastForcedRefreshAt = 0;

  constructor(
    private readonly lcd: LcdRenderer,
    private readonly weather: WeatherService,
    private readonly options: WidgetOptions = {},
  ) {}

  start(): void {
    window.addEventListener('online', this.onConnectionChange);
    window.addEventListener('offline', this.onConnectionChange);
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    if (this.options.autoLoad) {
      document.addEventListener('visibilitychange', this.onWake);
      window.addEventListener('focus', this.onWake);
      window.addEventListener('pageshow', this.onWake);
      this.refreshTimer = window.setInterval(this.onLiveRefresh, LIVE_REFRESH_MS);
      this.lastForcedRefreshAt = Date.now();
      void this.load(this.city);
    }
  }

  setWeather(snapshot: WeatherSnapshot): void {
    this.snapshot = snapshot;
    this.city = snapshot.city;
    this.loading = false;
    this.error = '';
    writeLastSnapshot(snapshot);
  }

  setLoading(city: City): void {
    this.city = city;
    this.loading = true;
    this.error = '';
  }

  dispose(): void {
    this.disposed = true;
    this.loadGeneration++;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('online', this.onConnectionChange);
    window.removeEventListener('offline', this.onConnectionChange);
    document.removeEventListener('visibilitychange', this.onWake);
    window.removeEventListener('focus', this.onWake);
    window.removeEventListener('pageshow', this.onWake);
    window.clearInterval(this.refreshTimer);
  }

  private readonly loop = (now: number): void => {
    if (this.disposed) return;
    const dt = Math.min(100, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;
    this.animTime += dt;
    this.draw(dt);
    this.raf = requestAnimationFrame(this.loop);
  };

  private async load(city: City, forceRefresh = false): Promise<void> {
    const generation = ++this.loadGeneration;
    if (forceRefresh) this.lastForcedRefreshAt = Date.now();
    this.setLoading(city);
    try {
      const snapshot = await this.weather.getSnapshot(city, undefined, forceRefresh);
      if (this.disposed || generation !== this.loadGeneration) return;
      this.setWeather(snapshot);
    } catch {
      if (this.disposed || generation !== this.loadGeneration) return;
      this.loading = false;
      this.error = 'BRAK DANYCH';
    }
  }

  private draw(dt: number): void {
    const lcd = this.lcd;
    lcd.clear();
    this.drawStatusBar();
    if (this.loading && !this.snapshot) {
      lcd.textCenter(52, 29, 'ŁADOWANIE');
      lcd.textCenter(52, 40, '.'.repeat(1 + Math.floor(this.animTime / 350) % 3));
      lcd.present(dt);
      return;
    }
    if (!this.snapshot) {
      lcd.textCenter(52, 28, this.error || 'BRAK DANYCH');
      lcd.textCenter(52, 41, 'DOTKNIJ, ABY OTWORZYĆ');
      lcd.present(dt);
      return;
    }

    const current = this.snapshot.current;
    lcd.text(2, 11, this.city.name.slice(0, 16));
    lcd.text(2, 20, roundTemp(current.tempC), 2);
    lcd.text(2, 36, conditionLabel(current.condition).slice(0, 15));
    const anim = WEATHER_ICONS[this.cloudAwareIcon(current.icon, current.cloudCoverPct)];
    const frame = Math.floor((this.animTime / 1000) * anim.fps);
    lcd.icon(84, 19, anim, frame);

    const hours = this.nextHours(this.snapshot.hourly, current.time);
    for (let i = 0; i < 7; i++) {
      const h = hours[i];
      if (!h) continue;
      const cx = ((i + 0.5) * 104) / 7;
      const digitRight = Math.round(cx + 3);
      tinyTextRight(lcd, digitRight, 46, String(Math.round(h.tempC)));
      tinyTextAt(lcd, digitRight + 2, 46, '°');
      tinyTextRight(lcd, digitRight, 55, hourLabel(h.time));
    }
    if (current.condition === 'thunderstorm' && frame % 4 === 1) lcd.flash(1);
    lcd.present(dt);
  }

  private drawStatusBar(): void {
    const lcd = this.lcd;
    this.drawSignal();
    lcd.text(36, 3, 'NOK');
    const pulse = Math.floor(this.animTime / 420) % 2 === 0;
    const heart = pulse
      ? ['0110110', '1111111', '1111111', '0111110', '0011100', '0001000']
      : ['01010', '11111', '11111', '01110', '00100'];
    const x = pulse ? 55 : 56;
    for (let y = 0; y < heart.length; y++) {
      for (let px = 0; px < heart[y].length; px++) {
        if (heart[y][px] === '1') lcd.setPixel(x + px, 3 + y);
      }
    }
    lcd.text(64, 3, 'A');
    this.drawBattery();
  }

  private nextHours(hours: HourPoint[], currentTime: string): HourPoint[] {
    const currentMs = Date.parse(currentTime);
    const aligned = hours.filter((item) => {
      const match = item.time.match(/T(\d{2})/);
      const itemMs = Date.parse(item.time);
      const afterCurrent = Number.isNaN(currentMs) || Number.isNaN(itemMs) || itemMs > currentMs;
      return afterCurrent && match != null && Number(match[1]) % 3 === 0;
    });
    if (aligned.length >= 7) return aligned.slice(0, 7);
    const future = hours.filter((item) => {
      const itemMs = Date.parse(item.time);
      return Number.isNaN(currentMs) || Number.isNaN(itemMs) || itemMs > currentMs;
    });
    return (aligned.length > 0 ? aligned : future.filter((_, index) => index % 3 === 0)).slice(0, 7);
  }

  private readonly onConnectionChange = (): void => {
    this.offline = !navigator.onLine;
    if (!this.offline && this.options.autoLoad) void this.load(this.city, true);
  };

  private readonly onLiveRefresh = (): void => {
    if (!this.disposed && navigator.onLine) void this.load(this.city, true);
  };

  private readonly onWake = (): void => {
    if (this.disposed || !this.options.autoLoad || !navigator.onLine) return;
    if (document.visibilityState === 'hidden') return;
    if (Date.now() - this.lastForcedRefreshAt < WAKE_DEBOUNCE_MS) return;
    void this.load(this.city, true);
  };

  private drawSignal(): void {
    const lcd = this.lcd;
    if (this.offline) {
      for (let i = 0; i < 6; i++) {
        lcd.setPixel(2 + i, 1 + i);
        lcd.setPixel(7 - i, 1 + i);
      }
      lcd.setPixel(9, 7);
      return;
    }
    for (let bar = 0; bar < 4; bar++) lcd.fillRect(2 + bar * 2, 7 - bar * 2, 1, bar * 2 + 1);
  }

  private drawBattery(): void {
    const lcd = this.lcd;
    lcd.frame(93, 2, 9, 6);
    lcd.fillRect(102, 4, 2, 2);
    if (Math.floor(this.animTime / 520) % 2 === 0) lcd.fillRect(95, 4, 1, 2);
  }

  private cloudAwareIcon(fallback: IconId, cloudCover: number): IconId {
    if (!['sun', 'suncloud', 'partcloud', 'cloud'].includes(fallback)) return fallback;
    if (cloudCover <= 12) return 'sun';
    if (cloudCover <= 45) return 'suncloud';
    if (cloudCover <= 88) return 'partcloud';
    return 'cloud';
  }
}
