/**
 * NOKIA 3310 WEATHER RETRO — terminal UI state machine.
 *
 * Drives the virtual 104x64 LCD with a small set of screens:
 *
 *   boot -> today / week / twoweeks / month   (forecast tabs)
 *          search / gps / voice / menu
 *
 * Input is abstracted into `UiEvent` (logical keys + character input)
 * so the same state machine is fed by the on-screen keypad, the
 * physical keyboard and swipe gestures — see main.ts.
 *
 * Multi-tap typing (classic Nokia): a digit key repeated within 800 ms
 * selects the next letter on that key; anything else commits the letter.
 */

import type { LcdRenderer } from '../graphics/lcd_renderer';
import { WEATHER_ICONS } from '../graphics/pixel_bitmaps';
import { textWidth } from '../graphics/bitmap_font';
import type { SpeechService, VoiceState } from '../services/speech_service';
import { extractPlace } from '../services/speech_service';
import { DEFAULT_CITY } from '../services/weather_service';
import type {
  City,
  DayPoint,
  Key,
  Provider,
  TabId,
  UiEvent,
  WeatherService,
  WeatherSnapshot
} from '../types/weather';
import { conditionLabel, TABS } from '../types/weather';

/* ------------------------------------------------------------------ *
 *  Constants
 * ------------------------------------------------------------------ */

type ScreenId = 'boot' | TabId | 'search' | 'gps' | 'voice' | 'menu';

const BOOT_MS = 1900;
const MULTITAP_MS = 800;
const SEARCH_DEBOUNCE_MS = 500;
const TOAST_MS = 2500;
const QUERY_MAX = 20;

/** Multi-tap keypad map (Nokia layout, 0 = space). */
const MULTITAP: Readonly<Record<string, string>> = {
  '2': 'ABC',
  '3': 'DEF',
  '4': 'GHI',
  '5': 'JKL',
  '6': 'MNO',
  '7': 'PQRS',
  '8': 'TUV',
  '9': 'WXYZ',
  '0': ' '
};

const DAY_NAMES = ['NIE', 'PON', 'WTO', 'ŚRO', 'CZW', 'PIĄ', 'SOB'];

const MENU_ITEMS = [
  'MIEJSCOWOŚĆ',
  'GPS - POZYCJA',
  'GŁOS',
  'ODŚWIEŻ DANE',
  'WYCZYŚĆ CACHE'
];

/** Short tab labels that fit the 4 x 26px tab-bar segments. */
const TAB_SHORT = ['DZIŚ', 'TYDZ', '2TYG', 'MIES'];

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

function isTabId(s: ScreenId): s is TabId {
  return s === 'today' || s === 'week' || s === 'twoweeks' || s === 'month';
}

/** Characters the search field accepts (A-Z, space, Polish diacritics). */
function isTypeable(ch: string): boolean {
  if (ch.length !== 1) return false;
  if (ch === ' ') return true;
  const c = ch.toUpperCase();
  if (c >= 'A' && c <= 'Z') return true;
  return 'ĄĆĘŁŃÓŚŹŻ'.includes(c);
}

/** Short provider tag drawn on the TODAY screen. */
function sourceLabel(p: Provider): string {
  if (p === 'open-meteo') return 'OM';
  if (p === 'met-no') return 'MET.NO';
  return 'WXAPI';
}

/* ------------------------------------------------------------------ *
 *  TerminalUI
 * ------------------------------------------------------------------ */

export class TerminalUI {
  private readonly lcd: LcdRenderer;
  private readonly weather: WeatherService;
  private readonly speech: SpeechService;

  private disposed = false;

  /** Current screen. */
  private screen: ScreenId = 'boot';
  /** Last forecast tab — where BACK / actions return the user. */
  private lastTab: TabId = 'today';
  /** Screen to return to after a menu action. */
  private menuReturnTo: ScreenId = 'today';

  /** Location + data. */
  private city: City = DEFAULT_CITY;
  private snapshot: WeatherSnapshot | null = null;
  private loading = false;
  private loadGen = 0;

  /** Clocks. */
  private bootStarted = 0;
  private animTime = 0;

  /** Toast. */
  private toastMsg = '';
  private toastUntil = 0;

  /** Search screen. */
  private query = '';
  private results: City[] = [];
  private resultIndex = 0;
  private searchBusy = false;
  private searchGen = 0;
  private searchStatus = '';
  private lastInputAt = 0;
  private lastSearchedQuery = '';

  /** GPS screen. */
  private gpsBusy = false;
  private gpsStatus = 'GOTOWY';

  /** Voice screen. */
  private voiceState: VoiceState = 'idle';
  private voiceMsg = 'POWIEDZ MIEJSCE';
  private voiceGen = 0;

  /** Menu screen. */
  private menuIndex = 0;

  /** Week / two-week scroll offset (rows). */
  private weekOffset = 0;

  /** Multi-tap state. */
  private pendingDigit: string | null = null;
  private pendingIdx = 0;
  private pendingAt = 0;

  constructor(
    lcd: LcdRenderer,
    weather: WeatherService,
    speech: SpeechService
  ) {
    this.lcd = lcd;
    this.weather = weather;
    this.speech = speech;
  }

  /* ------------------------------ lifecycle ------------------------ */

  /** Show the boot splash and prefetch the default city (cache-first). */
  start(): void {
    this.bootStarted = performance.now();
    this.screen = 'boot';
    this.lastTab = 'today';
    this.loadCity(DEFAULT_CITY, true);
  }

  /** Tear down: stop speech, invalidate pending async work. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadGen++;
    this.searchGen++;
    this.voiceGen++;
    this.speech.dispose();
  }

  /* ------------------------------- input --------------------------- */

  /** Handle a logical key or character event (see UiEvent). */
  onEvent(evt: UiEvent): void {
    if (this.disposed) return;

    if (this.screen === 'boot') {
      if (evt === 'OK' || evt === 'SOFTL' || evt === 'SOFT') this.screen = this.lastTab;
      return;
    }

    if (typeof evt !== 'string') {
      // Character input is only meaningful on the search screen.
      if (this.screen === 'search') this.onCharInput(evt.ch);
      return;
    }

    // Any key commits a pending multi-tap letter first.
    this.commitPending();

    if (evt === 'SOFTL' || evt === 'SOFT') {
      this.onSoft(evt);
      if (isTabId(this.screen)) this.lastTab = this.screen;
      return;
    }

    switch (this.screen) {
      case 'today':
      case 'week':
      case 'twoweeks':
      case 'month':
        this.onForecastKey(evt);
        break;
      case 'search':
        this.onSearchKey(evt);
        break;
      case 'gps':
        this.onGpsKey(evt);
        break;
      case 'voice':
        this.onVoiceKey(evt);
        break;
      case 'menu':
        this.onMenuKey(evt);
        break;
    }

    if (isTabId(this.screen)) this.lastTab = this.screen;
  }

  /** Character input on the search screen (direct letters, multi-tap digits). */
  private onCharInput(ch: string): void {
    if (ch >= '0' && ch <= '9') {
      this.onKeypadDigit(ch);
      return;
    }
    const up = ch.toUpperCase();
    if (!isTypeable(up) || this.query.length >= QUERY_MAX) return;
    this.query += up;
    this.lastInputAt = performance.now();
    this.resultIndex = 0;
  }

  /** Multi-tap: repeating the same digit within the window cycles letters. */
  private onKeypadDigit(d: string): void {
    const now = performance.now();
    if (this.pendingDigit === d && now - this.pendingAt <= MULTITAP_MS) {
      this.pendingIdx++;
    } else {
      this.commitPending();
      this.pendingDigit = d;
      this.pendingIdx = 0;
    }
    this.pendingAt = now;
    this.lastInputAt = now;
  }

  /** True while the search field expects character input (touch keyboard). */
  get wantsInput(): boolean {
    return this.screen === 'search';
  }

  /**
   * Touch input: map a tap in virtual LCD coordinates (0..103, 0..63)
   * to a screen action. The softkey strip is y >= 55; on the forecast
   * screens the tab bar (y9..16) is also tappable.
   */
  onTap(vx: number, vy: number): void {
    if (this.disposed) return;

    if (this.screen === 'boot') {
      this.screen = this.lastTab; // tap to skip the splash
      return;
    }

    // Softkey strip: left/right halves.
    if (vy >= 55) {
      this.onEvent(vx < 52 ? 'SOFTL' : 'SOFT');
      return;
    }

    // Tab bar (forecast screens only): 4 equal 26px segments.
    if (isTabId(this.screen) && vy >= 9 && vy <= 16) {
      this.screen = TABS[Math.min(3, Math.floor((vx / 104) * 4))].id;
      this.weekOffset = 0;
      this.lastTab = this.screen;
      return;
    }

    switch (this.screen) {
      case 'week':
      case 'twoweeks':
        // Scroll arrow zones (right edge).
        if (vx >= 88 && vy >= 17 && vy <= 22) this.scrollWeek(-1);
        else if (vx >= 88 && vy >= 40) this.scrollWeek(1);
        return;
      case 'search': {
        // Tap a visible result row -> select + load.
        if (vy >= 25 && vy <= 52) {
          const n = this.results.length;
          const first = Math.max(
            0,
            Math.min(this.resultIndex - 3, Math.max(0, n - 4)),
          );
          const idx = first + Math.min(3, Math.floor((vy - 25) / 7));
          if (idx < n) {
            this.resultIndex = idx;
            this.loadCity(this.results[idx]);
          }
        }
        return;
      }
      case 'gps':
      case 'voice':
        this.onEvent('OK'); // content tap = primary action
        return;
      case 'menu': {
        // Tap a menu item -> execute it.
        if (vy >= 18 && vy <= 52) {
          this.menuIndex = Math.min(MENU_ITEMS.length - 1, Math.floor((vy - 18) / 7));
          this.execMenu();
        }
        return;
      }
      default:
        break; // today / month: tabs + softkeys are enough
    }
  }

  /** Commit the pending multi-tap letter (if any) into the query. */
  private commitPending(): void {
    if (this.pendingDigit === null) return;
    const letters = MULTITAP[this.pendingDigit];
    const ch = letters ? letters[this.pendingIdx % letters.length] : '';
    this.pendingDigit = null;
    this.pendingIdx = 0;
    if (ch !== '' && this.query.length < QUERY_MAX) {
      this.query += ch;
      this.lastInputAt = performance.now();
      this.resultIndex = 0;
    }
  }

  /* ---------------------------- key handlers ----------------------- */

  private onForecastKey(key: Key): void {
    switch (key) {
      case 'LEFT':
      case 'RIGHT': {
        const i = TABS.findIndex((t) => t.id === this.screen);
        const n = TABS.length;
        this.screen = TABS[(i + (key === 'RIGHT' ? 1 : n - 1)) % n].id;
        this.weekOffset = 0;
        break;
      }
      case 'UP':
        if (this.screen === 'week' || this.screen === 'twoweeks') {
          this.scrollWeek(-1);
        } else {
          this.openSearch();
        }
        break;
      case 'DOWN':
        if (this.screen === 'week' || this.screen === 'twoweeks') {
          this.scrollWeek(1);
        } else {
          this.openMenu();
        }
        break;
      case 'OK':
        this.loadCity(this.city, true);
        break;
      case 'BACK':
      case 'MENU':
        this.openMenu();
        break;
      case 'DEL':
        break;
    }
  }

  private onSearchKey(key: Key): void {
    switch (key) {
      case 'UP':
        this.resultIndex = Math.max(0, this.resultIndex - 1);
        break;
      case 'DOWN':
        if (this.results.length > 0) {
          this.resultIndex = Math.min(this.results.length - 1, this.resultIndex + 1);
        }
        break;
      case 'OK': {
        const c = this.results[this.resultIndex];
        if (c) this.loadCity(c);
        else this.triggerSearch();
        break;
      }
      case 'DEL':
        if (this.query.length > 0) {
          this.query = this.query.slice(0, -1);
          this.lastInputAt = performance.now();
          this.resultIndex = 0;
        }
        break;
      case 'BACK':
        this.toForecast();
        break;
      case 'MENU':
        this.triggerSearch();
        break;
      case 'LEFT':
      case 'RIGHT':
        break;
    }
  }

  private onGpsKey(key: Key): void {
    if (key === 'OK') {
      if (!this.gpsBusy) this.startGps();
    } else if (key === 'BACK' || key === 'MENU') {
      this.toForecast();
    }
  }

  private onVoiceKey(key: Key): void {
    if (key === 'OK') {
      if (this.speech.listening) {
        this.speech.stop();
        this.voiceState = 'idle';
        this.voiceMsg = 'STOP';
      } else {
        this.startVoice();
      }
    } else if (key === 'BACK' || key === 'MENU') {
      this.speech.stop();
      this.voiceGen++;
      this.voiceState = 'idle';
      this.toForecast();
    }
  }

  private onMenuKey(key: Key): void {
    switch (key) {
      case 'UP':
        this.menuIndex = (this.menuIndex + MENU_ITEMS.length - 1) % MENU_ITEMS.length;
        break;
      case 'DOWN':
        this.menuIndex = (this.menuIndex + 1) % MENU_ITEMS.length;
        break;
      case 'OK':
        this.execMenu();
        break;
      case 'BACK':
      case 'MENU':
        this.toForecast();
        break;
      case 'LEFT':
      case 'RIGHT':
      case 'DEL':
        break;
    }
  }

  /* ----------------------------- softkeys -------------------------- */

  /** Context-dependent softkey action (bottom buttons / LCD softkey strip). */
  private onSoft(side: 'SOFTL' | 'SOFT'): void {
    switch (this.screen) {
      case 'today':
      case 'week':
      case 'twoweeks':
      case 'month':
        if (side === 'SOFTL') this.openMenu();
        else this.openSearch();
        break;
      case 'search': {
        if (side === 'SOFTL') {
          const c = this.results[this.resultIndex];
          if (c) this.loadCity(c);
          else this.triggerSearch();
        } else {
          this.query = '';
          this.results = [];
          this.resultIndex = 0;
          this.searchStatus = '';
          this.lastSearchedQuery = '';
          this.lastInputAt = performance.now();
        }
        break;
      }
      case 'gps':
        if (side === 'SOFTL') {
          if (!this.gpsBusy) this.startGps();
        } else {
          this.toForecast();
        }
        break;
      case 'voice':
        if (side === 'SOFTL') {
          if (this.speech.listening) {
            this.speech.stop();
            this.voiceState = 'idle';
            this.voiceMsg = 'STOP';
          } else {
            this.startVoice();
          }
        } else {
          this.speech.stop();
          this.voiceGen++;
          this.voiceState = 'idle';
          this.toForecast();
        }
        break;
      case 'menu':
        if (side === 'SOFTL') this.execMenu();
        else this.toForecast();
        break;
    }
  }

  /* ----------------------------- navigation ------------------------ */

  private openSearch(): void {
    this.commitPending();
    this.screen = 'search';
    this.query = '';
    this.results = [];
    this.resultIndex = 0;
    this.searchStatus = '';
    this.searchBusy = false;
    this.lastSearchedQuery = '';
    this.lastInputAt = 0;
    this.searchGen++;
  }

  private openMenu(): void {
    this.menuReturnTo = isTabId(this.screen) ? this.screen : this.lastTab;
    this.menuIndex = 0;
    this.screen = 'menu';
  }

  private toForecast(): void {
    this.screen = this.lastTab;
  }

  private scrollWeek(delta: number): void {
    const n = this.daysForScreen().length;
    this.weekOffset = Math.max(
      0,
      Math.min(this.weekOffset + delta, Math.max(0, n - 4))
    );
  }

  private daysForScreen(): DayPoint[] {
    const daily = this.snapshot?.daily ?? [];
    if (this.screen === 'week') return daily.slice(0, 7);
    if (this.screen === 'twoweeks') return daily.slice(0, 14);
    return daily;
  }

  private execMenu(): void {
    switch (this.menuIndex) {
      case 0:
        this.openSearch();
        break;
      case 1:
        this.screen = 'gps';
        this.gpsBusy = false;
        this.gpsStatus = 'GOTOWY';
        break;
      case 2:
        if (this.speech.supported) {
          this.screen = 'voice';
          this.voiceState = 'idle';
          this.voiceMsg = 'POWIEDZ MIEJSCE';
        } else {
          this.toToast('BRAK WSPARCIA MOWY');
        }
        break;
      case 3:
        this.screen = this.menuReturnTo;
        this.loadCity(this.city, true);
        break;
      default:
        this.weather.clearCache();
        this.toToast('WYCZYSZCZONO');
        this.screen = this.menuReturnTo;
        this.loadCity(this.city, true);
        break;
    }
  }

  /* ---------------------------- data actions ----------------------- */

  /**
   * Load a full snapshot for a city (cache -> provider cascade).
   * `stay = true` keeps the current screen (refresh in place);
   * otherwise we return to the "today" tab once the data lands.
   */
  loadCity(city: City, stay = false): void {
    this.city = city;
    this.loading = true;
    this.weekOffset = 0;
    const gen = ++this.loadGen;
    this.weather
      .getSnapshot(city)
      .then((snap) => {
        if (this.disposed || gen !== this.loadGen) return;
        this.snapshot = snap;
        this.loading = false;
        if (!stay) {
          if (this.screen !== 'boot') this.screen = 'today';
          this.toToast(sourceLabel(snap.source));
        }
      })
      .catch(() => {
        if (this.disposed || gen !== this.loadGen) return;
        this.loading = false;
        this.toToast('BRAK DANYCH');
      });
  }

  /** Geocoding search for the current query (generation-guarded). */
  private triggerSearch(): void {
    const q = this.query.trim();
    if (q.length < 2) {
      this.searchStatus = 'MIN. 2 ZNAKI';
      return;
    }
    this.lastSearchedQuery = this.query;
    this.searchBusy = true;
    this.searchStatus = 'SZUKAM...';
    const gen = ++this.searchGen;
    this.weather
      .searchCities(q, this.city?.country)
      .then((cities) => {
        if (this.disposed || gen !== this.searchGen) return;
        this.results = cities;
        this.resultIndex = 0;
        this.searchStatus =
          cities.length > 0 ? `${cities.length} WYNIKÓW` : 'BRAK WYNIKÓW';
      })
      .catch(() => {
        if (this.disposed || gen !== this.searchGen) return;
        this.searchStatus = 'BŁĄD POŁĄCZENIA';
      })
      .finally(() => {
        if (gen === this.searchGen) this.searchBusy = false;
      });
  }

  /** Locate the user via browser geolocation, then reverse-geocode. */
  private startGps(): void {
    if (this.gpsBusy) return;
    if (!('geolocation' in navigator)) {
      this.gpsStatus = 'BRAK GPS';
      return;
    }
    this.gpsBusy = true;
    this.gpsStatus = 'WYSZUKIWANIE...';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (this.disposed) return;
        this.gpsBusy = false;
        const pt = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        this.weather
          .reverseGeocode(pt)
          .then((city) => {
            if (!this.disposed) this.loadCity(city);
          })
          .catch(() => {
            if (!this.disposed) this.gpsStatus = 'BŁĄD GEO';
          });
      },
      (err) => {
        if (this.disposed) return;
        this.gpsBusy = false;
        this.gpsStatus = err.code === 1 ? 'ODMOWIONO DOSTĘPU' : 'BRAK POZYCJI';
      },
      { timeout: 10000, maximumAge: 5 * 60 * 1000 }
    );
  }

  /** Start speech recognition; on the final transcript, resolve the place. */
  private startVoice(): void {
    if (!this.speech.supported) {
      this.voiceMsg = 'BRAK WSPARCIA';
      return;
    }
    this.voiceMsg = 'SŁUCHAM...';
    this.speech.listen({
      onState: (s) => {
        if (!this.disposed) this.voiceState = s;
      },
      onTranscript: (text) => {
        if (this.disposed) return;
        const place = extractPlace(text);
        if (!place) {
          this.speech.stop();
          this.voiceState = 'idle';
          this.voiceMsg = 'NIE ROZUMIEM';
          return;
        }
        this.voiceMsg = `SZUKAM: ${place.slice(0, 8).toUpperCase()}`;
        const gen = ++this.voiceGen;
        this.weather
          .searchCities(place, this.city?.country)
          .then((cities) => {
            if (this.disposed || gen !== this.voiceGen) return;
            this.speech.stop();
            this.voiceState = 'idle';
            const c = cities[0];
            if (c) this.loadCity(c);
            else this.voiceMsg = 'NIE ZNALAZŁEM';
          })
          .catch(() => {
            if (this.disposed || gen !== this.voiceGen) return;
            this.speech.stop();
            this.voiceState = 'idle';
            this.voiceMsg = 'BŁĄD POŁĄCZENIA';
          });
      },
      onError: (msg) => {
        if (!this.disposed) {
          this.voiceState = 'idle';
          this.voiceMsg = msg;
        }
      }
    });
  }

  private toToast(msg: string): void {
    this.toastMsg = msg;
    this.toastUntil = performance.now() + TOAST_MS;
  }

  /* ------------------------------ rendering ------------------------ */

  /** Advance one animation step and blit a full LCD frame. */
  render(dtMs: number): void {
    if (this.disposed) return;
    const now = performance.now();
    this.animTime += dtMs;

    // Time-based multi-tap commit.
    if (this.pendingDigit !== null && now - this.pendingAt > MULTITAP_MS) {
      this.commitPending();
    }

    // Debounced search (500 ms after the last character).
    if (this.screen === 'search') {
      if (
        !this.searchBusy &&
        this.query !== this.lastSearchedQuery &&
        this.query.trim().length >= 2 &&
        now - this.lastInputAt >= SEARCH_DEBOUNCE_MS
      ) {
        this.triggerSearch();
      } else if (this.query.trim().length < 2 && this.lastSearchedQuery !== '') {
        // Query shrank below the minimum: invalidate, so re-typing the same
        // place (e.g. after ANULUJ) searches again instead of no-oping.
        this.lastSearchedQuery = '';
      }
    }

    // Boot splash finishes on its own.
    if (this.screen === 'boot' && now - this.bootStarted >= BOOT_MS) {
      this.screen = this.lastTab;
    }

    // Thunderstorm lightning flash.
    const cond = this.snapshot?.current.condition;
    if (cond === 'thunderstorm' && Math.random() < (dtMs / 1000) * 0.6) {
      this.lcd.flash(Math.random() < 0.35 ? 2 : 1);
    }

    const lcd = this.lcd;
    lcd.clear();
    this.drawStatusBar();
    if (isTabId(this.screen)) this.drawTabBar();
    switch (this.screen) {
      case 'boot':
        this.drawBoot(now);
        break;
      case 'today':
        this.drawToday();
        break;
      case 'week':
      case 'twoweeks':
        this.drawWeek();
        break;
      case 'month':
        this.drawMonth();
        break;
      case 'search':
        this.drawSearch(now);
        break;
      case 'gps':
        this.drawGps();
        break;
      case 'voice':
        this.drawVoice(now);
        break;
      case 'menu':
        this.drawMenu();
        break;
    }
    this.drawSoftkeys();
    this.drawToast(now);
    lcd.present(dtMs);
  }

  /* --------------------------- screen drawing ---------------------- */

  /** Top status strip: signal, battery, clock, brand. */
  private drawStatusBar(): void {
    const lcd = this.lcd;
    // Signal: 4 bars, bottom-aligned at y6.
    for (let i = 0; i < 4; i++) lcd.fillRect(1 + i * 2, 5 - i, 1, 2 + i);
    // Battery: frame + tip + 4 cells.
    lcd.frame(11, 1, 11, 6);
    lcd.fillRect(22, 3, 1, 2);
    for (let i = 0; i < 4; i++) lcd.fillRect(12 + i * 2, 2, 1, 4);
    // Clock + brand.
    lcd.textCenter(52, 1, new Date().toTimeString().slice(0, 5));
    lcd.text(104 - textWidth('NOKIA') - 2, 2, 'NOKIA');
  }

  /** Tab bar (y9..16): 4 equal segments, the active tab is inverted. */
  private drawTabBar(): void {
    const lcd = this.lcd;
    for (let i = 0; i < TABS.length; i++) {
      const x = i * 26;
      lcd.textCenter(x + 13, 10, TAB_SHORT[i]);
      if (TABS[i].id === this.screen) {
        lcd.invertRect(x, 9, i === TABS.length - 1 ? 26 : 25, 7);
      }
    }
  }

  private drawBoot(now: number): void {
    const lcd = this.lcd;
    lcd.textCenter(52, 16, 'NOKIA', 3);
    lcd.textCenter(52, 40, 'WEATHER');
    const p = Math.max(0, Math.min(1, (now - this.bootStarted - 700) / 1100));
    lcd.frame(12, 50, 80, 8);
    if (p > 0) lcd.fillRect(13, 51, Math.round(78 * p), 6);
  }

  private drawToday(): void {
    const s = this.snapshot;
    if (!s) {
      this.drawNoData();
      return;
    }
    const lcd = this.lcd;
    const cur = s.current;
    lcd.text(2, 17, s.city.name.slice(0, 12));
    const src = sourceLabel(s.source);
    lcd.text(102 - textWidth(src), 17, src);
    lcd.text(2, 25, `${Math.round(cur.tempC)}°`, 2);
    const anim = WEATHER_ICONS[cur.icon];
    lcd.icon(84, 24, anim, Math.floor(this.animTime / (1000 / anim.fps)));
    lcd.text(2, 39, conditionLabel(cur.condition));
    lcd.hline(0, 46, 104);
    // Hourly strip: next 6 slots (~3 h apart), temperature only.
    const n = Math.min(6, s.hourly.length);
    for (let i = 0; i < n; i++) {
      lcd.textCenter(9 + i * 17, 48, `${s.hourly[i].tempC}°`);
    }
  }

  /** Unified scrollable day table for the week / two-week tabs. */
  private drawWeek(): void {
    const days = this.daysForScreen();
    if (days.length === 0) {
      this.drawNoData();
      return;
    }
    const lcd = this.lcd;
    lcd.text(1, 17, 'DZIEŃ');
    lcd.text(19, 17, 'MIN');
    lcd.text(36, 17, 'MAX');
    lcd.text(63, 17, 'OPAD');
    if (this.weekOffset > 0) lcd.glyph(96, 17, 'arrowUp');
    if (this.weekOffset < days.length - 4) lcd.glyph(96, 46, 'arrowDown');
    for (let i = 0; i < 4; i++) {
      const d = days[this.weekOffset + i];
      if (!d) break;
      const y = 25 + i * 7;
      const name =
        this.weekOffset + i === 0 ? 'DZIŚ' : DAY_NAMES[d.weekday % 7];
      lcd.text(1, y, name);
      lcd.text(19, y, `${d.tempMinC}°`);
      lcd.text(36, y, `${d.tempMaxC}°`);
      lcd.miniIcon(54, y - 1, WEATHER_ICONS[d.icon], 0);
      lcd.text(63, y, `${d.precipProbPct}%`);
    }
  }

  /** Month tab: statistics row + bar chart of up to 16 days. */
  private drawMonth(): void {
    const days = this.snapshot?.daily;
    if (!days || days.length === 0) {
      this.drawNoData();
      return;
    }
    const lcd = this.lcd;
    let mn = Infinity;
    let mx = -Infinity;
    let sum = 0;
    let precip = 0;
    for (const d of days) {
      mn = Math.min(mn, d.tempMinC);
      mx = Math.max(mx, d.tempMaxC);
      sum += (d.tempMaxC + d.tempMinC) / 2;
      precip += d.precipMm;
    }
    const avg = Math.round(sum / days.length);
    lcd.text(1, 17, `ŚR:${avg}° MIN:${mn}°`);
    lcd.text(1, 24, `MAX:${mx}° OPAD:${Math.round(precip)}`);
    const n = days.length;
    const bw = 4;
    const gap = Math.max(1, Math.floor((100 - n * bw) / (n + 1)));
    const base = 51;
    const range = mx - mn;
    for (let i = 0; i < n; i++) {
      const x = 2 + i * (bw + gap);
      const h =
        range <= 0
          ? 9
          : Math.max(1, Math.round(((days[i].tempMaxC - mn) / range) * 18));
      lcd.fillRect(x, base - h, bw, h);
      if (days[i].precipMm > 0) lcd.fillRect(x, 52, bw, 1);
    }
  }

  private drawSearch(now: number): void {
    const lcd = this.lcd;
    // Input line: '>' prompt, query, blinking 5x7 cursor block.
    let q = this.query;
    if (textWidth(q) > 90) q = q.slice(-15);
    lcd.text(1, 9, '>');
    lcd.text(8, 9, q);
    if (Math.floor(now / 400) % 2 === 0) {
      lcd.fillRect(9 + textWidth(q), 9, 5, 7);
    }
    lcd.text(1, 17, this.searchStatus !== '' ? this.searchStatus : 'SZUKANIE MIEJSCA');
    if (this.results.length === 0 && !this.searchBusy) {
      lcd.text(
        1,
        25,
        this.query.trim().length >= 2 ? 'SZUKAM...' : 'WPISZ MIEJSCE'
      );
    }
    // 4-row scrolling result window; the selected row is inverted.
    const n = this.results.length;
    const first = Math.max(
      0,
      Math.min(this.resultIndex - 3, Math.max(0, n - 4))
    );
    for (let i = 0; i < 4 && first + i < n; i++) {
      const y = 25 + i * 7;
      const c = this.results[first + i];
      lcd.text(2, y, `${first + i + 1} ${c.name}`);
      if (first + i === this.resultIndex) lcd.invertRect(0, y, 104, 7);
    }
  }

  private drawGps(): void {
    const lcd = this.lcd;
    lcd.glyph(2, 10, 'gps');
    lcd.text(14, 10, 'LOKALIZACJA GPS');
    lcd.text(2, 26, this.gpsStatus);
    lcd.text(2, 36, 'OK: START');
    lcd.text(2, 44, 'BACK: ANULUJ');
  }

  private drawVoice(now: number): void {
    const lcd = this.lcd;
    const listening = this.voiceState === 'listening';
    const blink = Math.floor(now / 400) % 2 === 0;
    if (!listening || blink) lcd.glyph(2, 10, 'mic');
    lcd.text(14, 10, 'MOWA PO POLSKU');
    lcd.text(2, 26, this.voiceMsg);
    lcd.text(2, 36, 'OK: STOP/START');
    lcd.text(2, 44, 'BACK: WYJDŹ');
  }

  private drawMenu(): void {
    const lcd = this.lcd;
    lcd.textCenter(52, 9, 'MENU');
    for (let i = 0; i < MENU_ITEMS.length; i++) {
      const y = 18 + i * 7;
      lcd.text(8, y, MENU_ITEMS[i]);
      if (i === this.menuIndex) {
        lcd.glyph(95, y, 'arrowRight');
        lcd.invertRect(0, y, 104, 7);
      }
    }
  }

  private drawNoData(): void {
    const msg = this.loading ? 'ŁADOWANIE...' : 'BRAK DANYCH';
    this.lcd.textCenter(52, 30, msg);
  }

  /** Bottom softkey strip (decorative labels for the physical keys). */
  private drawSoftkeys(): void {
    if (this.screen === 'boot') return;
    const lcd = this.lcd;
    lcd.hline(0, 55, 104);
    let left = 'MENU';
    let right = 'MIEJ.';
    if (this.screen === 'search') {
      left = 'WYBIERZ';
      right = 'CZYŚĆ';
    } else if (this.screen === 'gps') {
      left = 'START';
      right = 'ANULUJ';
    } else if (this.screen === 'voice') {
      left = 'STOP/START';
      right = 'WYJDŹ';
    } else if (this.screen === 'menu') {
      left = 'WYBIERZ';
      right = 'WYJDŹ';
    }
    lcd.text(2, 57, left);
    lcd.text(102 - textWidth(right), 57, right);
  }

  /** Centered inverted toast (shown while loading or after an action). */
  private drawToast(now: number): void {
    if (!(this.loading || now < this.toastUntil)) return;
    const msg = this.loading ? 'ŁADOWANIE...' : this.toastMsg;
    if (msg === '') return;
    const w = textWidth(msg) + 8;
    const x = Math.round(52 - w / 2);
    this.lcd.text(x + 4, 28, msg);
    this.lcd.invertRect(x, 26, w, 11);
  }
}
