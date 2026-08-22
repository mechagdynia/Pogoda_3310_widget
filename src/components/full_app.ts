import { LcdRenderer } from '../graphics/lcd_renderer';
import type { AppLanguage } from '../i18n';
import { formatHour, formatShortDate, localeFor, tx } from '../i18n';
import {
  auroraKpThreshold,
  fetchAuroraForecast,
  isNightTime,
  moonInfo,
  moonPhaseLabel,
  moonWeek,
  nextFullMoon,
  type AuroraForecast,
} from '../services/astronomy_service';
import {
  getHoroscope,
  ZODIAC,
  zodiacDateRange,
  zodiacForDate,
  zodiacLabel,
  type ZodiacSign,
} from '../services/horoscope_service';
import { speechService, extractPlace } from '../services/speech_service';
import {
  astronomyEvents,
  formatPlanetBestTime,
  twilightHighlights,
  visiblePlanetFacts,
} from '../services/sky_events_service';
import { DEFAULT_CITY } from '../services/weather_service';
import { readLastSnapshot, writeLastSnapshot } from '../services/weather_storage';
import type { City, DayPoint, HourPoint, WeatherCondition, WeatherService, WeatherSnapshot } from '../types/weather';
import { conditionLabel } from '../types/weather';
import { WidgetUI } from './widget_ui';

const CITY_KEY = 'pogoda3310:selected-city';
const THEME_KEY = 'pogoda3310:skin';
const ZODIAC_KEY = 'pogoda3310:zodiac';
type Section = 'today' | 'hours' | 'week' | 'meteopath' | 'sky' | 'horoscope';
type Skin = 'retro' | 'aurora' | 'radar';

function readCity(): City {
  try {
    const raw = localStorage.getItem(CITY_KEY);
    if (raw) return JSON.parse(raw) as City;
  } catch { /* ignore unavailable storage */ }
  return DEFAULT_CITY;
}

function saveCity(city: City): void {
  try { localStorage.setItem(CITY_KEY, JSON.stringify(city)); } catch { /* no-op */ }
}

function readSkin(): Skin {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === 'retro' || value === 'aurora' || value === 'radar') return value;
  } catch { /* no-op */ }
  return 'retro';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[ch] ?? ch);
}

function dayName(day: DayPoint, index: number, language: AppLanguage): string {
  if (index === 0) return tx(language, 'Dzisiaj', 'Today');
  if (index === 1) return tx(language, 'Jutro', 'Tomorrow');
  const date = new Date(`${day.date}T12:00:00`);
  return date.toLocaleDateString(localeFor(language), { weekday: 'long' });
}

function compass(deg: number): string {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

export class FullWeatherApp {
  private city = readCity();
  private skin: Skin = readSkin();
  private generation = 0;
  private searchGeneration = 0;
  private widget: WidgetUI | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private listeners = new AbortController();
  private toastTimer = 0;
  private astroGeneration = 0;
  private horoscopeGeneration = 0;
  private aurora: AuroraForecast | null = null;
  private auroraStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private lastSnapshot: WeatherSnapshot | null = null;
  private selectedSign: ZodiacSign = this.readZodiac();
  private horoscopeText = '';
  private horoscopeDate = '';
  private horoscopeStale = false;
  private horoscopeLoading = false;
  private horoscopeError = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly weather: WeatherService,
    private readonly language: AppLanguage,
  ) {}

  start(): void {
    this.renderShell();
    this.bindEvents();
    this.applySkin(this.skin);
    this.setupHero();
    this.renderHoroscope();
    void this.loadHoroscope();
    const remembered = readLastSnapshot();
    if (remembered) {
      this.city = remembered.city;
      this.widget?.setWeather(remembered);
      this.renderData(remembered);
    }
    this.updateConnectionState();
    void this.loadCity(this.city);
  }

  dispose(): void {
    this.generation++;
    this.searchGeneration++;
    this.astroGeneration++;
    this.horoscopeGeneration++;
    this.listeners.abort();
    this.resizeObserver?.disconnect();
    this.widget?.dispose();
    speechService.dispose();
    window.clearTimeout(this.toastTimer);
  }

  private tx(polish: string, english: string): string {
    return tx(this.language, polish, english);
  }

  private readZodiac(): ZodiacSign {
    try {
      const saved = localStorage.getItem(ZODIAC_KEY) as ZodiacSign | null;
      if (saved && ZODIAC.some((item) => item.id === saved)) return saved;
    } catch { /* no-op */ }
    return zodiacForDate().id;
  }

  private renderShell(): void {
    this.root.className = 'weather-app';
    this.root.innerHTML = `
      <div class="ambient ambient-a"></div><div class="ambient ambient-b"></div>
      <div class="app-frame">
        <header class="app-header">
          <div class="brand-lockup" aria-label="${this.tx('Pogoda 3310', 'Weather 3310')}">
            <span class="brand-heart" aria-hidden="true">♥</span>
            <span><small>${this.tx('POGODA', 'WEATHER')}</small><strong>3310</strong></span>
          </div>
          <div class="header-actions">
            <button class="icon-button" data-action="voice" type="button" aria-label="${this.tx('Wyszukaj głosem', 'Voice search')}">◉</button>
            <button class="icon-button" data-action="menu" type="button" aria-label="${this.tx('Otwórz menu', 'Open menu')}">☰</button>
          </div>
        </header>

        <section class="location-bar" aria-label="${this.tx('Wybrana lokalizacja', 'Selected location')}">
          <button class="location-button" data-action="search" type="button">
            <span class="pin">◆</span><span><small>${this.tx('TERAZ', 'NOW')}</small><strong id="location-name">${escapeHtml(this.city.name)}</strong></span><span class="chevron">⌄</span>
          </button>
          <button class="gps-button" data-action="gps" type="button"><span>◎</span> ${this.tx('Moja pozycja', 'My location')}</button>
        </section>

        <section class="hero-card" aria-label="${this.tx('Aktualna pogoda', 'Current weather')}">
          <div class="hero-glow"></div>
          <div class="hero-lcd" id="lcd-wrap"><canvas id="lcd" width="416" height="256"></canvas></div>
          <div class="hero-meta">
            <span id="updated-label">${this.tx('Łączenie ze stacją…', 'Connecting to weather service…')}</span>
            <button data-action="refresh" type="button">↻ ${this.tx('Odśwież', 'Refresh')}</button>
          </div>
        </section>

        <nav class="section-tabs" aria-label="${this.tx('Widoki aplikacji', 'App views')}">
          <button class="active" data-section="today" type="button"><span>⌂</span>${this.tx('Dzisiaj', 'Today')}</button>
          <button data-section="hours" type="button"><span>◷</span>${this.tx('Godziny', 'Hourly')}</button>
          <button data-section="week" type="button"><span>▤</span>${this.tx('Prognoza', 'Forecast')}</button>
          <button data-section="meteopath" type="button"><span>♥</span>${this.tx('Meteopata', 'Sensitivity')}</button>
          <button data-section="sky" type="button"><span class="moon-glyph tab-moon phase-${moonInfo().phase}" aria-hidden="true"><i></i></span>${this.tx('Niebo', 'Sky')}</button>
          <button data-section="horoscope" type="button"><span id="zodiac-tab-icon">${ZODIAC.find((item) => item.id === this.selectedSign)?.icon ?? '♌'}</span>${this.tx('Horoskop', 'Horoscope')}</button>
        </nav>

        <div class="content-stack">
          <section class="app-section active" data-panel="today"><div class="skeleton-card"></div></section>
          <section class="app-section" data-panel="hours"></section>
          <section class="app-section" data-panel="week"></section>
          <section class="app-section" data-panel="meteopath"></section>
          <section class="app-section" data-panel="sky"></section>
          <section class="app-section" data-panel="horoscope"></section>
        </div>
        <footer class="app-footer">${this.tx('Dane: Open-Meteo / MET Norway / NOAA SWPC / Free Horoscope API · Informacje mają charakter orientacyjny', 'Data: Open-Meteo / MET Norway / NOAA SWPC / Free Horoscope API · Information is indicative')}</footer>
      </div>

      <div class="sheet-backdrop" data-dismiss="sheet" hidden></div>
      <aside class="sheet" id="search-sheet" aria-hidden="true">
        <div class="sheet-handle"></div>
        <div class="sheet-title"><div><small>${this.tx('LOKALIZACJA', 'LOCATION')}</small><h2>${this.tx('Znajdź miejscowość', 'Find a place')}</h2></div><button data-action="close-sheet" type="button">×</button></div>
        <label class="search-box"><span>⌕</span><input id="city-search" type="search" autocomplete="off" placeholder="${this.tx('np. Gdańsk', 'e.g. London')}" /><button data-action="voice" type="button" aria-label="${this.tx('Wpisz głosem', 'Voice input')}">◉</button></label>
        <p class="search-hint" id="search-hint">${this.tx('Wpisz co najmniej 2 znaki', 'Enter at least 2 characters')}</p>
        <div class="search-results" id="search-results"></div>
      </aside>

      <aside class="sheet menu-sheet" id="menu-sheet" aria-hidden="true">
        <div class="sheet-handle"></div>
        <div class="sheet-title"><div><small>${this.tx('POGODA 3310', 'WEATHER 3310')}</small><h2>${this.tx('Menu', 'Menu')}</h2></div><button data-action="close-sheet" type="button">×</button></div>
        <div class="menu-group">
          <h3>${this.tx('Skórka aplikacji', 'App theme')}</h3>
          <div class="skin-picker">
            <button data-skin="retro" type="button"><i class="swatch retro"></i>3310</button>
            <button data-skin="aurora" type="button"><i class="swatch aurora"></i>Aurora</button>
            <button data-skin="radar" type="button"><i class="swatch radar"></i>Radar</button>
          </div>
        </div>
        <div class="menu-list">
          <button data-action="gps" type="button"><span>◎</span><div><strong>${this.tx('Użyj GPS', 'Use GPS')}</strong><small>${this.tx('Automatycznie ustaw lokalizację', 'Set location automatically')}</small></div><b>›</b></button>
          <button data-action="voice" type="button"><span>◉</span><div><strong>${this.tx('Podaj miejscowość głosem', 'Say a place name')}</strong><small>${this.tx('Mikrofon i rozpoznawanie mowy', 'Microphone and speech recognition')}</small></div><b>›</b></button>
          <button data-action="widget-preview" type="button"><span>▣</span><div><strong>${this.tx('Podgląd widgetu 2×2', '2×2 widget preview')}</strong><small>${this.tx('Otwórz tryb dla ekranu głównego', 'Open home-screen mode')}</small></div><b>›</b></button>
          <button data-action="clear-cache" type="button"><span>↻</span><div><strong>${this.tx('Wyczyść dane lokalne', 'Clear local data')}</strong><small>${this.tx('Pobierz świeżą prognozę', 'Download a fresh forecast')}</small></div><b>›</b></button>
        </div>
      </aside>
      <div class="toast" id="toast" role="status"></div>`;
  }

  private setupHero(): void {
    const canvas = this.root.querySelector<HTMLCanvasElement>('#lcd');
    const host = this.root.querySelector<HTMLElement>('#lcd-wrap');
    if (!canvas || !host) return;
    const lcd = new LcdRenderer(canvas, host);
    this.widget = new WidgetUI(lcd, this.weather, { language: this.language });
    this.resizeObserver = new ResizeObserver(() => lcd.resize());
    this.resizeObserver.observe(host);
    this.widget.start();
  }

  private bindEvents(): void {
    const signal = this.listeners.signal;
    this.root.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action], [data-section], [data-skin], [data-zodiac], [data-city-index], [data-dismiss]');
      if (!target) return;
      const action = target.dataset.action;
      if (target.dataset.section) this.showSection(target.dataset.section as Section);
      else if (target.dataset.skin) this.applySkin(target.dataset.skin as Skin);
      else if (target.dataset.zodiac) this.selectZodiac(target.dataset.zodiac as ZodiacSign);
      else if (target.dataset.cityIndex) this.chooseSearchResult(Number(target.dataset.cityIndex));
      else if (target.dataset.dismiss) this.closeSheets();
      else if (action) void this.handleAction(action);
    }, { signal });

    const input = this.root.querySelector<HTMLInputElement>('#city-search');
    let timer = 0;
    input?.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void this.search(input.value), 380);
    }, { signal });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeSheets();
    }, { signal });
    window.addEventListener('offline', () => {
      this.updateConnectionState();
      this.showToast(this.tx('Tryb offline — pokazuję ostatnią zapamiętaną prognozę', 'Offline — showing the last saved forecast'));
    }, { signal });
    window.addEventListener('online', () => {
      this.updateConnectionState();
      void this.loadCity(this.city, true);
    }, { signal });
  }

  private async handleAction(action: string): Promise<void> {
    if (action === 'search') this.openSheet('search-sheet');
    if (action === 'menu') this.openSheet('menu-sheet');
    if (action === 'close-sheet') this.closeSheets();
    if (action === 'refresh') await this.loadCity(this.city, true);
    if (action === 'gps') await this.useGps();
    if (action === 'voice') this.useVoice();
    if (action === 'widget-preview') {
      const url = new URL(location.href);
      url.searchParams.set('view', 'widget');
      location.href = url.toString();
    }
    if (action === 'clear-cache') {
      this.weather.clearCache();
      this.showToast(this.tx('Pamięć podręczna wyczyszczona', 'Cache cleared'));
      await this.loadCity(this.city, true);
    }
  }

  private async loadCity(city: City, refreshed = false): Promise<void> {
    const generation = ++this.generation;
    this.city = city;
    this.widget?.setLoading(city);
    this.setBusy(true);
    try {
      const snapshot = await this.weather.getSnapshot(city, undefined, refreshed);
      if (generation !== this.generation) return;
      this.city = snapshot.city;
      saveCity(this.city);
      writeLastSnapshot(snapshot);
      this.widget?.setWeather(snapshot);
      this.renderData(snapshot);
      this.closeSheets();
      if (refreshed) this.showToast(this.tx('Prognoza odświeżona', 'Forecast refreshed'));
    } catch {
      if (generation !== this.generation) return;
      const remembered = readLastSnapshot();
      if (remembered) {
        this.city = remembered.city;
        this.widget?.setWeather(remembered);
        this.renderData(remembered);
        this.showToast(this.tx('Offline — ostatnia zapamiętana prognoza', 'Offline — last saved forecast'));
      } else {
        this.showToast(this.tx('Nie udało się pobrać pogody', 'Could not download weather data'));
      }
    } finally {
      if (generation === this.generation) this.setBusy(false);
    }
  }

  private renderData(snapshot: WeatherSnapshot): void {
    this.lastSnapshot = snapshot;
    const c = snapshot.current;
    const precipNow = snapshot.hourly[0]?.precipProbPct ?? (c.precipMm > 0 ? 100 : 0);
    const location = this.root.querySelector<HTMLElement>('#location-name');
    const updated = this.root.querySelector<HTMLElement>('#updated-label');
    if (location) location.textContent = snapshot.city.name;
    if (updated) updated.textContent = navigator.onLine
      ? `${this.tx('Aktualizacja', 'Updated')} ${formatHour(snapshot.fetchedAt, this.language)} · ${snapshot.source.toUpperCase()}`
      : `OFFLINE · ${this.tx('zapamiętano', 'saved')} ${formatHour(snapshot.fetchedAt, this.language)}`;

    this.setPanel('today', `
      <div class="section-heading"><div><small>${this.tx('WARUNKI TERAZ', 'CONDITIONS NOW')}</small><h2>${this.tx('W skrócie', 'At a glance')}</h2></div><span class="quality-pill">${this.tx('DANE ONLINE', 'LIVE DATA')}</span></div>
      <div class="metric-grid">
        ${this.metric('◒', this.tx('Odczuwalna', 'Feels like'), `${Math.round(c.feelsLikeC)}°C`, this.tx('Temperatura odczuwalna', 'Apparent temperature'))}
        ${this.metric('●', this.tx('Wilgotność', 'Humidity'), `${Math.round(c.humidityPct)}%`, c.humidityPct > 75 ? this.tx('Wysoka', 'High') : this.tx('Komfortowa', 'Comfortable'))}
        ${this.metric('➤', this.tx('Wiatr', 'Wind'), `${Math.round(c.windKmh)} km/h`, compass(c.windDirDeg))}
        ${this.metric('▱', this.tx('Ciśnienie', 'Pressure'), `${Math.round(c.pressureHpa)} hPa`, this.pressureLabel(c.pressureHpa))}
        ${this.metric('◌', this.tx('Widoczność', 'Visibility'), c.visibilityKm == null ? '—' : `${Math.round(c.visibilityKm)} km`, this.tx('Na poziomie gruntu', 'At ground level'))}
        ${this.metric('☼', this.tx('Indeks UV', 'UV index'), c.uvIndex == null ? '—' : c.uvIndex.toFixed(1), this.uvLabel(c.uvIndex))}
        ${this.metric('☂', this.tx('Szansa opadu', 'Rain chance'), `${Math.round(precipNow)}%`, `${c.precipMm.toFixed(1)} mm ${this.tx('teraz', 'now')}`)}
        ${this.metric('☁', this.tx('Zachmurzenie', 'Cloud cover'), `${Math.round(c.cloudCoverPct)}%`, this.cloudLabel(c.cloudCoverPct))}
      </div>
      <div class="insight-card"><div class="insight-weather">${this.animatedWeather(c.condition, c.cloudCoverPct, c.time, snapshot.daily)}</div><div><small>${this.tx('WSKAZÓWKA NA TERAZ', 'TIP FOR NOW')}</small><strong>${this.advice(snapshot)}</strong><p>${conditionLabel(c.condition, this.language)} · ${this.tx('opady', 'rain')} ${Math.round(precipNow)}% · ${this.tx('zachmurzenie', 'clouds')} ${Math.round(c.cloudCoverPct)}%</p></div></div>`);

    const hours = snapshot.hourly.slice(0, 24);
    this.setPanel('hours', `
      <div class="section-heading hours-heading"><div><h2>${this.tx('Najbliższe godziny', 'Next hours')}</h2></div><span>${hours.length} ${this.tx('pomiarów', 'readings')}</span></div>
      <div class="hourly-strip">${hours.map((h, i) => `
        <article class="hour-card ${i === 0 ? 'now' : ''}"><time datetime="${escapeHtml(h.time)}">${formatHour(h.time, this.language)}</time>${this.animatedWeather(h.condition, h.cloudCoverPct, h.time, snapshot.daily)}<small class="rain-prob"><b>${Math.round(h.precipProbPct)}%</b> ${this.tx('opadów', 'rain')}</small><small>➤ ${Math.round(h.windKmh)} km/h</small></article>`).join('')}</div>
      <div class="chart-card"><div class="chart-title"><strong>${this.tx('Temperatura i godziny', 'Temperature and time')}</strong><span>${this.tx('Cienkie linie prowadzą do punktów', 'Thin guides lead to data points')}</span></div>${this.temperatureChart(hours)}</div>`);

    const days = snapshot.daily.slice(0, 14);
    this.setPanel('week', `
      <div class="section-heading"><div><small>${this.tx('PROGNOZA DŁUGOTERMINOWA', 'LONG-RANGE FORECAST')}</small><h2>${this.tx('Do 14 dni', 'Up to 14 days')}</h2></div><span>${days.length} ${this.tx('dni', 'days')}</span></div>
      <div class="forecast-list">${days.map((d, i) => `
        <article class="forecast-row"><div><strong>${escapeHtml(dayName(d, i, this.language))}</strong><small>${escapeHtml(formatShortDate(`${d.date}T12:00:00`, this.language))}</small></div>${this.animatedWeather(d.condition)}<span class="condition-copy">${escapeHtml(conditionLabel(d.condition, this.language))}<small>☂ ${Math.round(d.precipProbPct)}% · ${d.precipMm.toFixed(1)} mm</small></span><span class="range"><b>${Math.round(d.tempMaxC)}°</b><em>${Math.round(d.tempMinC)}°</em></span></article>`).join('')}</div>`);

    const score = this.meteopathScore(snapshot);
    this.setPanel('meteopath', `
      <div class="section-heading"><div><small>${this.tx('STREFA METEOPATY', 'WEATHER SENSITIVITY')}</small><h2>${this.tx('Wpływ pogody', 'Weather impact')}</h2></div><span class="quality-pill neutral">${this.tx('ORIENTACYJNE', 'INDICATIVE')}</span></div>
      <div class="meteo-score"><div class="score-ring" style="--score:${score.value}"><span><strong>${score.value}</strong><small>/ 10</small></span></div><div><small>${this.tx('OBCIĄŻENIE POGODOWE', 'WEATHER LOAD')}</small><h3>${score.label}</h3><p>${score.description}</p></div></div>
      <div class="sensitivity-grid">
        ${this.sensitivity('pressure', '▱', this.tx('Ciśnienie', 'Pressure'), this.pressureLabel(c.pressureHpa), Math.min(100, Math.abs(c.pressureHpa - 1013) * 5), `${Math.round(c.pressureHpa)} hPa`)}
        ${this.sensitivity('humidity', '●', this.tx('Wilgotność', 'Humidity'), c.humidityPct > 75 ? this.tx('wysoka', 'high') : this.tx('umiarkowana', 'moderate'), c.humidityPct, `${Math.round(c.humidityPct)}%`)}
        ${this.sensitivity('wind', '➤', this.tx('Wiatr', 'Wind'), c.windKmh > 35 ? this.tx('silny', 'strong') : this.tx('spokojny', 'calm'), Math.min(100, c.windKmh * 2), `${Math.round(c.windKmh)} km/h`)}
        ${this.sensitivity('uv', '☼', this.tx('Promieniowanie UV', 'UV radiation'), this.uvLabel(c.uvIndex), Math.min(100, (c.uvIndex ?? 0) * 10), c.uvIndex?.toFixed(1) ?? '—')}
      </div>
      <div class="medical-note">${this.tx('To wskaźnik informacyjny obliczony z pogody, nie porada medyczna. Przy nasilonych objawach kieruj się zaleceniami lekarza.', 'This is an informational weather-derived indicator, not medical advice. Seek medical guidance if symptoms worsen.')}</div>`);

    this.renderSky(snapshot);
    void this.loadAurora(snapshot);
  }

  private renderSky(snapshot: WeatherSnapshot): void {
    const currentMoon = moonInfo();
    const fullMoon = nextFullMoon();
    const daysToFull = Math.max(1, Math.ceil((fullMoon.getTime() - Date.now()) / 86_400_000));
    const week = moonWeek();
    const threshold = auroraKpThreshold(snapshot.city.lat);
    const aurora = this.aurora;
    const auroraPossible = aurora != null && aurora.maxKp >= threshold;
    const peak = aurora?.peakTime ? new Date(`${aurora.peakTime}Z`) : null;
    const phenomena = this.atmosphericPhenomena(snapshot);
    const twilight = twilightHighlights(snapshot, this.language);
    const skyReference = Number.isFinite(Date.parse(snapshot.current.time)) ? new Date(snapshot.current.time) : new Date();
    const planets = visiblePlanetFacts(snapshot, this.language, skyReference);
    const nearestPlanet = planets[0];
    const skyEvents = astronomyEvents(snapshot, this.language, skyReference);

    this.setPanel('sky', `
      <div class="section-heading"><div><small>${this.tx('KSIĘŻYC I ATMOSFERA', 'MOON AND ATMOSPHERE')}</small><h2>${this.tx('Niebo nad', 'Sky above')} ${escapeHtml(snapshot.city.name)}</h2></div><span class="quality-pill neutral">7 ${this.tx('DNI', 'DAYS')}</span></div>
      <div class="moon-hero">
        <span class="moon-glyph moon-glyph-large phase-${currentMoon.phase}" aria-hidden="true"><i></i></span>
        <div><small>${this.tx('DZISIEJSZA FAZA', "TODAY'S PHASE")}</small><h3>${moonPhaseLabel(currentMoon.phase, this.language)}</h3><p>${this.tx('Oświetlenie', 'Illumination')} ${currentMoon.illuminationPct}% · ${this.tx('wiek', 'age')} ${currentMoon.ageDays.toFixed(1)} ${this.tx('dnia', 'days')}</p></div>
      </div>
      <div class="full-moon-card"><span class="moon-glyph phase-full"><i></i></span><div><small>${this.tx('NAJBLIŻSZA PEŁNIA', 'NEXT FULL MOON')}</small><strong>${escapeHtml(fullMoon.toLocaleDateString(localeFor(this.language), { weekday: 'long', day: 'numeric', month: 'long' }))}</strong><p>${this.tx(`Za około ${daysToFull} dni · obliczenie astronomiczne`, `In about ${daysToFull} days · astronomical calculation`)}</p></div></div>
      <div class="moon-week" aria-label="${this.tx('Fazy Księżyca na siedem dni', 'Seven-day Moon phases')}">${week.map((moon, index) => `
        <article><small>${index === 0 ? this.tx('DZIŚ', 'TODAY') : moon.date.toLocaleDateString(localeFor(this.language), { weekday: 'short' }).replace('.', '')}</small><span class="moon-glyph phase-${moon.phase}"><i></i></span><strong>${moon.illuminationPct}%</strong><em>${escapeHtml(moonPhaseLabel(moon.phase, this.language))}</em></article>`).join('')}</div>
      <div class="sky-subheading"><div><small>${this.tx('ZŁOTA GODZINA', 'GOLDEN HOUR')}</small><h3>${this.tx('Wschody i zachody', 'Sunrises and sunsets')}</h3></div><span>${this.tx('DZIŚ + JUTRO', 'TODAY + TOMORROW')}</span></div>
      <div class="twilight-grid">${twilight.map((item) => `
        <article class="twilight-card ${item.kind} quality-${Math.min(9, item.score)}"><span>${item.icon}</span><div><small>${escapeHtml(item.dayLabel)} · ${escapeHtml(item.timeLabel)}</small><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.reason)}</p></div></article>`).join('')}</div>
      <p class="source-note">${this.tx('Ocena kolorów jest orientacyjnym wnioskiem z niskich, średnich i wysokich chmur, opadów oraz widzialności — nie gwarancją.', 'Colour quality is an indicative inference from low, mid and high cloud, rain risk, and visibility — not a guarantee.')}</p>
      <div class="sky-subheading"><div><small>${this.tx('AKTYWNOŚĆ ZORZOWA', 'AURORA ACTIVITY')}</small><h3>${this.tx('Prognoza NOAA SWPC', 'NOAA SWPC forecast')}</h3></div><span>${aurora ? `Kp ${aurora.maxKp.toFixed(1)}` : 'Kp —'}</span></div>
      <div class="aurora-card ${auroraPossible ? 'possible' : ''}">
        <span class="aurora-animation"><i></i><b></b></span>
        <div>${aurora ? `
          <strong>${auroraPossible ? this.tx('Możliwa zorza w Twojej okolicy', 'Aurora may be visible nearby') : this.tx('Mała szansa na zorzę w tej lokalizacji', 'Low aurora chance at this location')}</strong>
          <p>${this.tx('Maksimum prognozy', 'Forecast maximum')}: Kp ${aurora.maxKp.toFixed(1)}, ${this.tx('próg orientacyjny dla szerokości', 'indicative threshold for latitude')} ${Math.abs(snapshot.city.lat).toFixed(1)}°: Kp ${threshold}. ${peak ? `${this.tx('Szczyt', 'Peak')}: ${peak.toLocaleString(localeFor(this.language), { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.` : ''}</p>
        ` : this.auroraStatus === 'error'
          ? `<strong>${this.tx('NOAA jest chwilowo niedostępne', 'NOAA is temporarily unavailable')}</strong><p>${this.tx('Spróbuj ponownie przy następnym odświeżeniu. Pozostała prognoza działa normalnie.', 'Try again on the next refresh. The rest of the forecast still works normally.')}</p>`
          : `<strong>${this.tx('Pobieram prognozę pogody kosmicznej…', 'Loading space-weather forecast…')}</strong><p>${this.tx('NOAA publikuje wiarygodną prognozę Kp na około 3 dni.', 'NOAA provides a reliable Kp forecast for roughly 3 days.')}</p>`}</div>
      </div>
      <div class="sky-subheading"><div><small>${this.tx('MOŻLIWE ZJAWISKA', 'POSSIBLE PHENOMENA')}</small><h3>${this.tx('Najbliższy tydzień', 'Next seven days')}</h3></div></div>
      <div class="phenomena-list">${phenomena.map((item) => `<article><span>${item.icon}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div><time>${escapeHtml(item.date)}</time></article>`).join('')}</div>
      <div class="sky-subheading"><div><small>${this.tx('ASTRONOMICZNE CIEKAWOSTKI', 'ASTRONOMY HIGHLIGHTS')}</small><h3>${this.tx('Co warto wypatrywać', 'What to look for')}</h3></div><span>${this.tx('DLA TEJ LOKALIZACJI', 'FOR THIS LOCATION')}</span></div>
      ${nearestPlanet ? `<article class="nearest-planet-card"><span>${nearestPlanet.icon}</span><div><small>${this.tx('NAJBLIŻSZA Z WIDOCZNYCH W CIĄGU 24 H', 'NEAREST VISIBLE IN THE NEXT 24H')}</small><strong>${escapeHtml(nearestPlanet.name)}</strong><p>${this.tx(
        `Około ${nearestPlanet.distanceMillionKm.toFixed(1)} mln km od Ziemi (${nearestPlanet.distanceAu.toFixed(2)} AU). Najlepsza wysokość około ${formatPlanetBestTime(nearestPlanet, snapshot, this.language)}: ${Math.round(nearestPlanet.altitudeDeg)}° nad horyzontem.`,
        `About ${nearestPlanet.distanceMillionKm.toFixed(1)} million km from Earth (${nearestPlanet.distanceAu.toFixed(2)} AU). Best altitude around ${formatPlanetBestTime(nearestPlanet, snapshot, this.language)}: ${Math.round(nearestPlanet.altitudeDeg)}° above the horizon.`,
      )}</p></div></article>` : `<div class="medical-note">${this.tx('W ciągu najbliższych 24 godzin żadna z pięciu jasnych planet nie osiąga wygodnej wysokości na ciemnym niebie.', 'None of the five bright planets reaches a comfortable altitude in dark skies during the next 24 hours.')}</div>`}
      <div class="space-events">${skyEvents.map((event) => `<article><span>${event.icon}</span><div><strong>${escapeHtml(event.title)}</strong><p>${escapeHtml(event.detail)}</p></div></article>`).join('')}</div>
      <p class="source-note">${this.tx('Planety i zaćmienia: lokalne obliczenia Astronomy Engine (efemerydy VSOP87/NOVAS). Roje meteorów: kalendarz IMO. To astronomia, nie astrologia; teren, światła miasta i chmury wpływają na widoczność.', 'Planets and eclipses: local Astronomy Engine calculations (VSOP87/NOVAS ephemerides). Meteor showers: IMO calendar. Terrain, city lights, and cloud affect visibility.')}</p>
      <p class="source-note">${this.tx('Zorza: prognoza planetarnego indeksu Kp NOAA SWPC. Widoczność zależy też od chmur, ciemności i lokalnych warunków.', 'Aurora: NOAA SWPC planetary Kp forecast. Visibility also depends on clouds, darkness, and local conditions.')}</p>`);
  }

  private atmosphericPhenomena(snapshot: WeatherSnapshot): Array<{ icon: string; title: string; detail: string; date: string }> {
    const results: Array<{ icon: string; title: string; detail: string; date: string }> = [];
    const days = snapshot.daily.slice(0, 7);
    const add = (day: DayPoint, icon: string, plTitle: string, enTitle: string, plDetail: string, enDetail: string): void => {
      if (results.some((item) => item.title === this.tx(plTitle, enTitle))) return;
      results.push({
        icon,
        title: this.tx(plTitle, enTitle),
        detail: this.tx(plDetail, enDetail),
        date: formatShortDate(`${day.date}T12:00:00`, this.language),
      });
    };
    for (const day of days) {
      if ((day.condition === 'rain' || day.condition === 'drizzle') && day.precipProbPct >= 25 && day.precipProbPct <= 85) {
        add(day, '◒', 'Możliwa tęcza', 'Possible rainbow', 'Przelotny deszcz i przejaśnienia mogą stworzyć dobre warunki.', 'Showers and brighter spells may create favourable conditions.');
      }
      if (day.condition === 'thunderstorm') add(day, 'ϟ', 'Aktywność burzowa', 'Thunderstorm activity', 'Możliwe błyskawice — obserwuj niebo tylko z bezpiecznego miejsca.', 'Lightning is possible — watch only from a safe place.');
      if (day.condition === 'fog') add(day, '≋', 'Mgła i niskie chmury', 'Fog and low cloud', 'O świcie krajobraz może wyglądać wyjątkowo retro.', 'The landscape may look especially atmospheric near dawn.');
      if (day.condition === 'snow' || day.condition === 'heavy-snow' || day.condition === 'sleet') add(day, '✣', 'Zjawiska zimowe', 'Wintry phenomena', 'Możliwe płatki śniegu, szadź lub deszcz ze śniegiem.', 'Snowflakes, rime, or sleet may be visible.');
      if ((day.condition === 'clear' || day.condition === 'partly-cloudy') && day.precipProbPct < 20) {
        add(day, '✦', 'Dobre okno do obserwacji', 'Good observing window', 'Mało opadów sprzyja obserwacji Księżyca i jasnych planet.', 'Low rain risk favours observing the Moon and bright planets.');
      }
    }
    if (results.length === 0 && days[0]) {
      add(days[0], '◎', 'Spokojne niebo', 'Quiet sky', 'Prognoza nie wskazuje wyraźnego zjawiska — warto wypatrywać zmian lokalnie.', 'No strong signal in the forecast — local changes may still be worth watching.');
    }
    return results.slice(0, 4);
  }

  private async loadAurora(snapshot: WeatherSnapshot): Promise<void> {
    const generation = ++this.astroGeneration;
    this.auroraStatus = 'loading';
    try {
      const aurora = await fetchAuroraForecast();
      if (generation !== this.astroGeneration || this.lastSnapshot !== snapshot) return;
      this.aurora = aurora;
      this.auroraStatus = 'ready';
      this.renderSky(snapshot);
    } catch {
      if (generation !== this.astroGeneration || this.lastSnapshot !== snapshot) return;
      this.aurora = null;
      this.auroraStatus = 'error';
      this.renderSky(snapshot);
    }
  }

  private renderHoroscope(): void {
    const sign = ZODIAC.find((item) => item.id === this.selectedSign) ?? zodiacForDate();
    const dateLabel = this.horoscopeDate
      ? new Date(`${this.horoscopeDate}T12:00:00`).toLocaleDateString(localeFor(this.language), { weekday: 'long', day: 'numeric', month: 'long' })
      : new Date().toLocaleDateString(localeFor(this.language), { weekday: 'long', day: 'numeric', month: 'long' });
    this.setPanel('horoscope', `
      <div class="section-heading"><div><small>${this.tx('HOROSKOP DZIENNY', 'DAILY HOROSCOPE')}</small><h2>${this.tx('Kosmiczna prognoza', 'Cosmic forecast')}</h2></div><span class="quality-pill neutral">${escapeHtml(dateLabel)}</span></div>
      <div class="zodiac-picker" aria-label="${this.tx('Wybierz znak zodiaku', 'Choose a zodiac sign')}">${ZODIAC.map((item) => `
        <button class="${item.id === sign.id ? 'active' : ''}" data-zodiac="${item.id}" type="button"><span>${item.icon}</span><small>${escapeHtml(zodiacLabel(item, this.language))}</small></button>`).join('')}</div>
      <div class="horoscope-card">
        <div class="zodiac-orbit"><span>${sign.icon}</span><i></i></div>
        <div><small class="selected-zodiac-name">${escapeHtml(zodiacLabel(sign, this.language))} <span>(${escapeHtml(zodiacDateRange(sign, this.language))})</span></small><h3>${this.tx('Horoskop na dziś', 'Horoscope for today')}</h3>
          ${this.horoscopeLoading ? `<p class="horoscope-loading">${this.tx('Czytam układ gwiazd…', 'Reading the stars…')}</p>` : ''}
          ${this.horoscopeError ? `<p>${escapeHtml(this.horoscopeError)}</p>` : ''}
          ${this.horoscopeText ? `<p>${escapeHtml(this.horoscopeText)}</p>` : ''}
        </div>
      </div>
      ${this.horoscopeStale ? `<div class="medical-note">${this.tx('API jest chwilowo niedostępne — pokazuję ostatni zapamiętany horoskop z datą powyżej.', 'The API is temporarily unavailable — showing the last saved horoscope dated above.')}</div>` : ''}
      <p class="source-note">${this.tx('Źródło tekstu: Free Horoscope API, zapasowo API Ninjas. Tłumaczenie polskie: MyMemory. Horoskop służy wyłącznie rozrywce.', 'Text source: Free Horoscope API, with API Ninjas as fallback. Horoscope content is for entertainment only.')}</p>`);
  }

  private selectZodiac(sign: ZodiacSign): void {
    if (!ZODIAC.some((item) => item.id === sign)) return;
    this.selectedSign = sign;
    try { localStorage.setItem(ZODIAC_KEY, sign); } catch { /* no-op */ }
    const icon = this.root.querySelector<HTMLElement>('#zodiac-tab-icon');
    const definition = ZODIAC.find((item) => item.id === sign);
    if (icon && definition) icon.textContent = definition.icon;
    this.horoscopeText = '';
    this.horoscopeError = '';
    this.renderHoroscope();
    void this.loadHoroscope();
  }

  private async loadHoroscope(): Promise<void> {
    const generation = ++this.horoscopeGeneration;
    this.horoscopeLoading = true;
    this.horoscopeError = '';
    this.renderHoroscope();
    try {
      const result = await getHoroscope(this.selectedSign, this.language);
      if (generation !== this.horoscopeGeneration) return;
      this.horoscopeText = result.text;
      this.horoscopeDate = result.date;
      this.horoscopeStale = result.stale;
    } catch {
      if (generation !== this.horoscopeGeneration) return;
      this.horoscopeError = this.tx('Nie udało się pobrać horoskopu. Spróbuj ponownie później.', 'Could not load the horoscope. Please try again later.');
    } finally {
      if (generation === this.horoscopeGeneration) {
        this.horoscopeLoading = false;
        this.renderHoroscope();
      }
    }
  }

  private metric(icon: string, label: string, value: string, detail: string): string {
    return `<article class="metric-card"><span>${icon}</span><div><small>${label}</small><strong>${value}</strong><em>${detail}</em></div></article>`;
  }

  private sensitivity(kind: string, icon: string, name: string, label: string, value: number, reading: string): string {
    return `<article class="sensitivity"><span class="sensitivity-icon ${kind}"><i></i><b>${icon}</b></span><div class="sensitivity-copy"><div><strong>${name}</strong><span>${reading}</span></div><div class="meter"><i style="width:${Math.max(5, value)}%"></i></div><small>${label}</small></div></article>`;
  }

  private temperatureChart(hours: HourPoint[]): string {
    if (hours.length < 2) return `<p>${this.tx('Za mało danych do wykresu.', 'Not enough data for the chart.')}</p>`;
    const values = hours.map((item) => item.tempC);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(1, max - min);
    const step = 64;
    const width = Math.max(560, (values.length - 1) * step + 48);
    const baseline = 125;
    const height = 158;
    const coords = values.map((value, i) => ({ x: 24 + i * step, y: 104 - ((value - min) / range) * 70, value }));
    const points = coords.map((point) => `${point.x},${point.y}`).join(' ');
    const guides = coords.map((point, i) => `<line x1="${point.x}" y1="${point.y + 5}" x2="${point.x}" y2="${baseline}" class="chart-guide"/><circle cx="${point.x}" cy="${point.y}" r="4" class="chart-point"/><text x="${point.x}" y="${point.y - 10}" class="chart-temp">${Math.round(point.value)}°</text><text x="${point.x}" y="${baseline + 22}" class="chart-hour">${i === 0 ? this.tx('TERAZ', 'NOW') : formatHour(hours[i].time, this.language)}</text>`).join('');
    return `<div class="chart-scroll"><svg class="temp-chart" style="width:${width}px" viewBox="0 0 ${width} ${height}" role="img" aria-label="${this.tx('Wykres temperatury z godzinami', 'Temperature chart with times')}"><polyline points="${points}" class="chart-line"/>${guides}</svg></div>`;
  }

  private advice(snapshot: WeatherSnapshot): string {
    const c = snapshot.current;
    if (c.condition === 'thunderstorm') return this.tx('Możliwa gwałtowna burza — sprawdź komunikaty dla swojego regionu przed wyjściem.', 'A severe storm is possible — check local alerts before going out.');
    if (c.condition === 'heavy-rain') return this.tx('Mocna ulewa — sprawdź lokalne komunikaty, a jeśli wychodzisz, wybierz wodoodporny zestaw.', 'Heavy rain — check local alerts and choose waterproof clothing if you go out.');
    if (c.condition === 'heavy-snow') return this.tx('Intensywny śnieg — sprawdź komunikaty drogowe i zaplanuj spokojniejszą trasę.', 'Heavy snow — check travel alerts and choose a safer route.');
    if (c.condition === 'rain' || c.condition === 'drizzle' || c.precipMm > 0) return this.tx('Kalosze, lekka peleryna i spacer nadal może być bardzo przyjemny.', 'Wellies and a light raincoat can still make for a lovely walk.');
    if (c.condition === 'snow' || c.condition === 'sleet') return this.tx('Ciepły szalik, rękawiczki i można ruszać podziwiać zimową pogodę.', 'A warm scarf and gloves are a fine kit for enjoying wintry weather.');
    if (c.condition === 'fog') return this.tx('Jasna kurtka z odblaskiem pomoże bezpiecznie cieszyć się mglistym porankiem.', 'A bright reflective jacket helps you enjoy a misty morning safely.');
    if ((c.uvIndex ?? 0) >= 6) return this.tx('Słońce dopisuje — okulary, krem UV i coś do picia będą idealnym zestawem.', 'Sunshine is strong — sunglasses, sunscreen, and water make a great kit.');
    if (c.windKmh > 40) return this.tx('Wiatroszczelna kurtka i pewnie zapięty kaptur uprzyjemnią wyjście.', 'A windproof jacket and secure hood will make going out more comfortable.');
    if (c.tempC < 3) return this.tx('Czapka, szalik i ciepłe warstwy zrobią z chłodu dobrego kompana spaceru.', 'A hat, scarf, and warm layers will make the chill a good walking companion.');
    return this.tx('Warunki zachęcają do wyjścia — dobierz wygodne ubranie i korzystaj z dnia.', 'Conditions invite you outside — dress comfortably and enjoy the day.');
  }

  private cloudLabel(value: number): string {
    if (value <= 12) return this.tx('pełne słońce', 'full sunshine');
    if (value <= 45) return this.tx('dużo słońca', 'mostly sunny');
    if (value <= 88) return this.tx('słońce zza chmur', 'sun behind clouds');
    return this.tx('pełne chmury', 'overcast');
  }

  private animatedWeather(condition: WeatherCondition, cloudCover?: number, time?: string, daily: DayPoint[] = []): string {
    let kind = 'cloud-high';
    if (condition === 'thunderstorm') kind = 'thunder';
    else if (condition === 'rain' || condition === 'heavy-rain' || condition === 'drizzle') kind = 'rain';
    else if (condition === 'snow' || condition === 'heavy-snow' || condition === 'sleet') kind = 'snow';
    else if (condition === 'fog') kind = 'fog';
    else {
      const cover = cloudCover ?? (condition === 'clear' ? 5 : condition === 'partly-cloudy' ? 45 : condition === 'cloudy' ? 78 : 100);
      const night = time ? isNightTime(time, daily) : false;
      if (night && cover <= 18) kind = 'moon-clear';
      else if (night && cover <= 55) kind = 'moon-low';
      else if (night && cover <= 88) kind = 'moon-mid';
      else if (cover <= 12) kind = 'sunny';
      else if (cover <= 45) kind = 'cloud-low';
      else if (cover <= 88) kind = 'cloud-mid';
    }
    return `<span class="weather-anim ${kind}" aria-label="${escapeHtml(conditionLabel(condition, this.language))}"><i class="sun-rays"></i><i class="sun-disc"></i><i class="moon-weather"></i><i class="night-star"></i><i class="cloud-shape"></i><i class="rain-lines"><b></b><b></b><b></b></i><i class="lightning">ϟ</i><i class="snowflakes">✣ · ✣</i><i class="fog-lines">≋</i></span>`;
  }

  private pressureLabel(value: number): string {
    if (value < 995) return this.tx('bardzo niskie', 'very low');
    if (value < 1008) return this.tx('niskie', 'low');
    if (value > 1028) return this.tx('wysokie', 'high');
    return this.tx('stabilne', 'stable');
  }

  private uvLabel(value?: number): string {
    if (value == null) return this.tx('brak danych', 'no data');
    if (value < 3) return this.tx('niski', 'low');
    if (value < 6) return this.tx('umiarkowany', 'moderate');
    if (value < 8) return this.tx('wysoki', 'high');
    return this.tx('bardzo wysoki', 'very high');
  }

  private meteopathScore(snapshot: WeatherSnapshot): { value: number; label: string; description: string } {
    const c = snapshot.current;
    let value = 1;
    value += Math.min(3, Math.round(Math.abs(c.pressureHpa - 1013) / 8));
    if (c.humidityPct > 75) value += 2;
    if (c.windKmh > 30) value += 2;
    if (c.precipMm > 0 || c.condition === 'thunderstorm') value += 2;
    value = Math.min(10, value);
    if (value <= 3) return { value, label: this.tx('Niskie', 'Low'), description: this.tx('Warunki atmosferyczne są łagodne dla osób wrażliwych.', 'Atmospheric conditions are gentle for weather-sensitive people.') };
    if (value <= 6) return { value, label: this.tx('Umiarkowane', 'Moderate'), description: this.tx('Możliwa jest lekka senność, rozdrażnienie lub ból głowy.', 'Mild tiredness, irritability, or headache may occur.') };
    return { value, label: this.tx('Podwyższone', 'Elevated'), description: this.tx('Zadbaj dziś o nawodnienie, odpoczynek i spokojniejsze tempo.', 'Stay hydrated, rest, and take a gentler pace today.') };
  }

  private setPanel(id: Section, html: string): void {
    const panel = this.root.querySelector<HTMLElement>(`[data-panel="${id}"]`);
    if (panel) panel.innerHTML = html;
  }

  private showSection(section: Section): void {
    this.root.querySelectorAll<HTMLElement>('[data-section]').forEach((el) => el.classList.toggle('active', el.dataset.section === section));
    this.root.querySelectorAll<HTMLElement>('[data-panel]').forEach((el) => el.classList.toggle('active', el.dataset.panel === section));
    if (section === 'horoscope' && !this.horoscopeText && !this.horoscopeLoading) void this.loadHoroscope();
  }

  private setBusy(busy: boolean): void {
    this.root.classList.toggle('is-loading', busy);
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="refresh"]').forEach((button) => { button.disabled = busy; });
  }

  private updateConnectionState(): void {
    const offline = !navigator.onLine;
    this.root.classList.toggle('is-offline', offline);
    if (!offline) return;
    const updated = this.root.querySelector<HTMLElement>('#updated-label');
    const remembered = readLastSnapshot();
    if (updated && remembered) updated.textContent = `OFFLINE · ${this.tx('zapamiętano', 'saved')} ${formatHour(remembered.fetchedAt, this.language)}`;
  }

  private openSheet(id: string): void {
    this.closeSheets();
    const sheet = this.root.querySelector<HTMLElement>(`#${id}`);
    const backdrop = this.root.querySelector<HTMLElement>('.sheet-backdrop');
    if (!sheet || !backdrop) return;
    backdrop.hidden = false;
    requestAnimationFrame(() => { sheet.classList.add('open'); backdrop.classList.add('open'); });
    sheet.setAttribute('aria-hidden', 'false');
    if (id === 'search-sheet') window.setTimeout(() => this.root.querySelector<HTMLInputElement>('#city-search')?.focus(), 250);
  }

  private closeSheets(): void {
    this.root.querySelectorAll<HTMLElement>('.sheet').forEach((sheet) => { sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true'); });
    const backdrop = this.root.querySelector<HTMLElement>('.sheet-backdrop');
    if (backdrop) {
      backdrop.classList.remove('open');
      window.setTimeout(() => { if (!backdrop.classList.contains('open')) backdrop.hidden = true; }, 250);
    }
  }

  private searchResults: City[] = [];

  private async search(query: string): Promise<void> {
    const hint = this.root.querySelector<HTMLElement>('#search-hint');
    const list = this.root.querySelector<HTMLElement>('#search-results');
    const q = query.trim();
    const generation = ++this.searchGeneration;
    if (!list || !hint) return;
    if (q.length < 2) { hint.textContent = this.tx('Wpisz co najmniej 2 znaki', 'Enter at least 2 characters'); list.innerHTML = ''; return; }
    hint.textContent = this.tx('Szukam…', 'Searching…');
    try {
      const cities = await this.weather.searchCities(q, this.city.country);
      if (generation !== this.searchGeneration) return;
      this.searchResults = cities.slice(0, 8);
      hint.textContent = cities.length ? `${cities.length} ${this.tx('znalezionych miejsc', 'places found')}` : this.tx('Brak wyników', 'No results');
      list.innerHTML = this.searchResults.map((city, i) => `<button data-city-index="${i}" type="button"><span class="result-pin">◆</span><div><strong>${escapeHtml(city.name)}</strong><small>${escapeHtml([city.admin, city.country].filter(Boolean).join(', '))}</small></div><b>›</b></button>`).join('');
    } catch {
      if (generation === this.searchGeneration) hint.textContent = this.tx('Nie udało się wyszukać', 'Search failed');
    }
  }

  private chooseSearchResult(index: number): void {
    const city = this.searchResults[index];
    if (city) void this.loadCity(city);
  }

  private async useGps(): Promise<void> {
    if (!navigator.geolocation) { this.showToast(this.tx('Ta przeglądarka nie obsługuje GPS', 'This browser does not support GPS')); return; }
    this.showToast(this.tx('Ustalam pozycję…', 'Finding your location…'));
    try {
      const point = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 }));
      const city = await this.weather.reverseGeocode({ lat: point.coords.latitude, lon: point.coords.longitude });
      await this.loadCity(city);
      this.showToast(`${this.tx('Ustawiono', 'Set to')}: ${city.name}`);
    } catch {
      this.showToast(this.tx('Brak dostępu do lokalizacji', 'Location access unavailable'));
    }
  }

  private useVoice(): void {
    if (!speechService.supported) { this.showToast(this.tx('Rozpoznawanie mowy jest tu niedostępne', 'Speech recognition is unavailable here')); return; }
    this.openSheet('search-sheet');
    this.showToast(this.tx('Powiedz nazwę miejscowości…', 'Say a place name…'));
    speechService.listen({
      onState: () => undefined,
      onTranscript: (transcript) => {
        const place = extractPlace(transcript) || transcript;
        const input = this.root.querySelector<HTMLInputElement>('#city-search');
        if (input) input.value = place;
        void this.search(place);
      },
      onError: (message) => this.showToast(message),
    }, this.language);
  }

  private applySkin(skin: Skin): void {
    this.skin = skin;
    this.root.dataset.skin = skin;
    try { localStorage.setItem(THEME_KEY, skin); } catch { /* no-op */ }
    this.root.querySelectorAll<HTMLElement>('[data-skin]').forEach((button) => button.classList.toggle('active', button.dataset.skin === skin));
  }

  private showToast(message: string): void {
    const toast = this.root.querySelector<HTMLElement>('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2800);
  }
}
