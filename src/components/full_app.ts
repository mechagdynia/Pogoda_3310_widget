import { LcdRenderer } from '../graphics/lcd_renderer';
import { speechService, extractPlace } from '../services/speech_service';
import { DEFAULT_CITY } from '../services/weather_service';
import { readLastSnapshot, writeLastSnapshot } from '../services/weather_storage';
import type { City, DayPoint, HourPoint, WeatherCondition, WeatherService, WeatherSnapshot } from '../types/weather';
import { conditionLabel } from '../types/weather';
import { WidgetUI } from './widget_ui';

const CITY_KEY = 'pogoda3310:selected-city';
const THEME_KEY = 'pogoda3310:skin';
type Section = 'today' | 'hours' | 'week' | 'meteopath';
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

function hour(iso: string): string {
  const parsed = new Date(iso);
  if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  return iso.match(/T(\d{2}):?(\d{2})?/)?.slice(1).filter(Boolean).join(':') ?? '--';
}

function dayName(day: DayPoint, index: number): string {
  if (index === 0) return 'Dzisiaj';
  if (index === 1) return 'Jutro';
  const date = new Date(`${day.date}T12:00:00`);
  return date.toLocaleDateString('pl-PL', { weekday: 'long' });
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

  constructor(
    private readonly root: HTMLElement,
    private readonly weather: WeatherService,
  ) {}

  start(): void {
    this.renderShell();
    this.bindEvents();
    this.applySkin(this.skin);
    this.setupHero();
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
    this.listeners.abort();
    this.resizeObserver?.disconnect();
    this.widget?.dispose();
    speechService.dispose();
    window.clearTimeout(this.toastTimer);
  }

  private renderShell(): void {
    this.root.className = 'weather-app';
    this.root.innerHTML = `
      <div class="ambient ambient-a"></div><div class="ambient ambient-b"></div>
      <div class="app-frame">
        <header class="app-header">
          <div class="brand-lockup" aria-label="Pogoda 3310">
            <span class="brand-heart" aria-hidden="true">♥</span>
            <span><small>POGODA</small><strong>3310</strong></span>
          </div>
          <div class="header-actions">
            <button class="icon-button" data-action="voice" type="button" aria-label="Wyszukaj głosem">◉</button>
            <button class="icon-button" data-action="menu" type="button" aria-label="Otwórz menu">☰</button>
          </div>
        </header>

        <section class="location-bar" aria-label="Wybrana lokalizacja">
          <button class="location-button" data-action="search" type="button">
            <span class="pin">◆</span><span><small>TERAZ</small><strong id="location-name">${escapeHtml(this.city.name)}</strong></span><span class="chevron">⌄</span>
          </button>
          <button class="gps-button" data-action="gps" type="button"><span>◎</span> Moja pozycja</button>
        </section>

        <section class="hero-card" aria-label="Aktualna pogoda">
          <div class="hero-glow"></div>
          <div class="hero-lcd" id="lcd-wrap"><canvas id="lcd" width="416" height="256"></canvas></div>
          <div class="hero-meta">
            <span id="updated-label">Łączenie ze stacją…</span>
            <button data-action="refresh" type="button">↻ Odśwież</button>
          </div>
        </section>

        <nav class="section-tabs" aria-label="Widoki prognozy">
          <button class="active" data-section="today" type="button"><span>⌂</span>Dzisiaj</button>
          <button data-section="hours" type="button"><span>◷</span>Godziny</button>
          <button data-section="week" type="button"><span>▤</span>Prognoza</button>
          <button data-section="meteopath" type="button"><span>♥</span>Meteopata</button>
        </nav>

        <div class="content-stack">
          <section class="app-section active" data-panel="today"><div class="skeleton-card"></div></section>
          <section class="app-section" data-panel="hours"></section>
          <section class="app-section" data-panel="week"></section>
          <section class="app-section" data-panel="meteopath"></section>
        </div>
        <footer class="app-footer">Dane pogodowe: Open-Meteo / MET Norway · Prognoza ma charakter informacyjny</footer>
      </div>

      <div class="sheet-backdrop" data-dismiss="sheet" hidden></div>
      <aside class="sheet" id="search-sheet" aria-hidden="true">
        <div class="sheet-handle"></div>
        <div class="sheet-title"><div><small>LOKALIZACJA</small><h2>Znajdź miejscowość</h2></div><button data-action="close-sheet" type="button">×</button></div>
        <label class="search-box"><span>⌕</span><input id="city-search" type="search" autocomplete="off" placeholder="np. Gdańsk" /><button data-action="voice" type="button" aria-label="Wpisz głosem">◉</button></label>
        <p class="search-hint" id="search-hint">Wpisz co najmniej 2 znaki</p>
        <div class="search-results" id="search-results"></div>
      </aside>

      <aside class="sheet menu-sheet" id="menu-sheet" aria-hidden="true">
        <div class="sheet-handle"></div>
        <div class="sheet-title"><div><small>POGODA 3310</small><h2>Menu</h2></div><button data-action="close-sheet" type="button">×</button></div>
        <div class="menu-group">
          <h3>Skórka aplikacji</h3>
          <div class="skin-picker">
            <button data-skin="retro" type="button"><i class="swatch retro"></i>3310</button>
            <button data-skin="aurora" type="button"><i class="swatch aurora"></i>Aurora</button>
            <button data-skin="radar" type="button"><i class="swatch radar"></i>Radar</button>
          </div>
        </div>
        <div class="menu-list">
          <button data-action="gps" type="button"><span>◎</span><div><strong>Użyj GPS</strong><small>Automatycznie ustaw lokalizację</small></div><b>›</b></button>
          <button data-action="voice" type="button"><span>◉</span><div><strong>Podaj miejscowość głosem</strong><small>Mikrofon i rozpoznawanie mowy</small></div><b>›</b></button>
          <button data-action="widget-preview" type="button"><span>▣</span><div><strong>Podgląd widgetu 2×2</strong><small>Otwórz tryb dla ekranu głównego</small></div><b>›</b></button>
          <button data-action="clear-cache" type="button"><span>↻</span><div><strong>Wyczyść dane lokalne</strong><small>Pobierz świeżą prognozę</small></div><b>›</b></button>
        </div>
      </aside>
      <div class="toast" id="toast" role="status"></div>`;
  }

  private setupHero(): void {
    const canvas = this.root.querySelector<HTMLCanvasElement>('#lcd');
    const host = this.root.querySelector<HTMLElement>('#lcd-wrap');
    if (!canvas || !host) return;
    const lcd = new LcdRenderer(canvas, host);
    this.widget = new WidgetUI(lcd, this.weather);
    this.resizeObserver = new ResizeObserver(() => lcd.resize());
    this.resizeObserver.observe(host);
    this.widget.start();
  }

  private bindEvents(): void {
    const signal = this.listeners.signal;
    this.root.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action], [data-section], [data-skin], [data-city-index], [data-dismiss]');
      if (!target) return;
      const action = target.dataset.action;
      if (target.dataset.section) this.showSection(target.dataset.section as Section);
      else if (target.dataset.skin) this.applySkin(target.dataset.skin as Skin);
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
      this.showToast('Tryb offline — pokazuję ostatnią zapamiętaną prognozę');
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
      this.showToast('Cache wyczyszczony');
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
      if (refreshed) this.showToast('Prognoza odświeżona');
    } catch {
      if (generation !== this.generation) return;
      const remembered = readLastSnapshot();
      if (remembered) {
        this.city = remembered.city;
        this.widget?.setWeather(remembered);
        this.renderData(remembered);
        this.showToast('Offline — ostatnia zapamiętana prognoza');
      } else {
        this.showToast('Nie udało się pobrać pogody');
      }
    } finally {
      if (generation === this.generation) this.setBusy(false);
    }
  }

  private renderData(snapshot: WeatherSnapshot): void {
    const c = snapshot.current;
    const precipNow = snapshot.hourly[0]?.precipProbPct ?? (c.precipMm > 0 ? 100 : 0);
    const location = this.root.querySelector<HTMLElement>('#location-name');
    const updated = this.root.querySelector<HTMLElement>('#updated-label');
    if (location) location.textContent = snapshot.city.name;
    if (updated) updated.textContent = navigator.onLine
      ? `Aktualizacja ${hour(snapshot.fetchedAt)} · ${snapshot.source.toUpperCase()}`
      : `OFFLINE · zapamiętano ${hour(snapshot.fetchedAt)}`;

    this.setPanel('today', `
      <div class="section-heading"><div><small>WARUNKI TERAZ</small><h2>W skrócie</h2></div><span class="quality-pill">DANE ONLINE</span></div>
      <div class="metric-grid">
        ${this.metric('◒', 'Odczuwalna', `${Math.round(c.feelsLikeC)}°C`, 'Temperatura odczuwalna')}
        ${this.metric('●', 'Wilgotność', `${Math.round(c.humidityPct)}%`, c.humidityPct > 75 ? 'Wysoka' : 'Komfortowa')}
        ${this.metric('➤', 'Wiatr', `${Math.round(c.windKmh)} km/h`, compass(c.windDirDeg))}
        ${this.metric('▱', 'Ciśnienie', `${Math.round(c.pressureHpa)} hPa`, this.pressureLabel(c.pressureHpa))}
        ${this.metric('◌', 'Widoczność', c.visibilityKm == null ? '—' : `${Math.round(c.visibilityKm)} km`, 'Na poziomie gruntu')}
        ${this.metric('☼', 'Indeks UV', c.uvIndex == null ? '—' : c.uvIndex.toFixed(1), this.uvLabel(c.uvIndex))}
        ${this.metric('☂', 'Szansa opadu', `${Math.round(precipNow)}%`, `${c.precipMm.toFixed(1)} mm teraz`)}
        ${this.metric('☁', 'Zachmurzenie', `${Math.round(c.cloudCoverPct)}%`, this.cloudLabel(c.cloudCoverPct))}
      </div>
      <div class="insight-card"><div class="insight-weather">${this.animatedWeather(c.condition, c.cloudCoverPct)}</div><div><small>WSKAZÓWKA NA TERAZ</small><strong>${this.advice(snapshot)}</strong><p>${conditionLabel(c.condition)} · opady ${Math.round(precipNow)}% · zachmurzenie ${Math.round(c.cloudCoverPct)}%</p></div></div>`);

    const hours = snapshot.hourly.slice(0, 24);
    this.setPanel('hours', `
      <div class="section-heading"><div><small>PROGNOZA GODZINOWA</small><h2>Najbliższe godziny</h2></div><span>${hours.length} pomiarów</span></div>
      <div class="hourly-strip">${hours.map((h, i) => `
        <article class="hour-card ${i === 0 ? 'now' : ''}">${this.animatedWeather(h.condition, h.cloudCoverPct)}<small class="rain-prob"><b>${Math.round(h.precipProbPct)}%</b> opadów</small><small>➤ ${Math.round(h.windKmh)} km/h</small></article>`).join('')}</div>
      <div class="chart-card"><div class="chart-title"><strong>Temperatura i godziny</strong><span>Cienkie linie prowadzą do punktów</span></div>${this.temperatureChart(hours)}</div>`);

    const days = snapshot.daily.slice(0, 14);
    this.setPanel('week', `
      <div class="section-heading"><div><small>PROGNOZA DŁUGOTERMINOWA</small><h2>Do 14 dni</h2></div><span>${days.length} dni</span></div>
      <div class="forecast-list">${days.map((d, i) => `
        <article class="forecast-row"><div><strong>${escapeHtml(dayName(d, i))}</strong><small>${escapeHtml(new Date(`${d.date}T12:00:00`).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' }))}</small></div>${this.animatedWeather(d.condition)}<span class="condition-copy">${escapeHtml(conditionLabel(d.condition))}<small>☂ ${Math.round(d.precipProbPct)}% · ${d.precipMm.toFixed(1)} mm</small></span><span class="range"><b>${Math.round(d.tempMaxC)}°</b><em>${Math.round(d.tempMinC)}°</em></span></article>`).join('')}</div>`);

    const score = this.meteopathScore(snapshot);
    this.setPanel('meteopath', `
      <div class="section-heading"><div><small>STREFA METEOPATY</small><h2>Wpływ pogody</h2></div><span class="quality-pill neutral">ORIENTACYJNE</span></div>
      <div class="meteo-score"><div class="score-ring" style="--score:${score.value}"><span><strong>${score.value}</strong><small>/ 10</small></span></div><div><small>OBCIĄŻENIE POGODOWE</small><h3>${score.label}</h3><p>${score.description}</p></div></div>
      <div class="sensitivity-grid">
        ${this.sensitivity('pressure', '▱', 'Ciśnienie', this.pressureLabel(c.pressureHpa), Math.min(100, Math.abs(c.pressureHpa - 1013) * 5), `${Math.round(c.pressureHpa)} hPa`)}
        ${this.sensitivity('humidity', '●', 'Wilgotność', c.humidityPct > 75 ? 'wysoka' : 'umiarkowana', c.humidityPct, `${Math.round(c.humidityPct)}%`)}
        ${this.sensitivity('wind', '➤', 'Wiatr', c.windKmh > 35 ? 'silny' : 'spokojny', Math.min(100, c.windKmh * 2), `${Math.round(c.windKmh)} km/h`)}
        ${this.sensitivity('uv', '☼', 'Promieniowanie UV', this.uvLabel(c.uvIndex), Math.min(100, (c.uvIndex ?? 0) * 10), c.uvIndex?.toFixed(1) ?? '—')}
      </div>
      <div class="medical-note">To wskaźnik informacyjny obliczony z pogody, nie porada medyczna. Przy nasilonych objawach kieruj się zaleceniami lekarza.</div>`);
  }

  private metric(icon: string, label: string, value: string, detail: string): string {
    return `<article class="metric-card"><span>${icon}</span><div><small>${label}</small><strong>${value}</strong><em>${detail}</em></div></article>`;
  }

  private sensitivity(kind: string, icon: string, name: string, label: string, value: number, reading: string): string {
    return `<article class="sensitivity"><span class="sensitivity-icon ${kind}"><i></i><b>${icon}</b></span><div class="sensitivity-copy"><div><strong>${name}</strong><span>${reading}</span></div><div class="meter"><i style="width:${Math.max(5, value)}%"></i></div><small>${label}</small></div></article>`;
  }

  private temperatureChart(hours: HourPoint[]): string {
    if (hours.length < 2) return '<p>Za mało danych do wykresu.</p>';
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
    const guides = coords.map((point, i) => `<line x1="${point.x}" y1="${point.y + 5}" x2="${point.x}" y2="${baseline}" class="chart-guide"/><circle cx="${point.x}" cy="${point.y}" r="4" class="chart-point"/><text x="${point.x}" y="${point.y - 10}" class="chart-temp">${Math.round(point.value)}°</text><text x="${point.x}" y="${baseline + 22}" class="chart-hour">${i === 0 ? 'TERAZ' : hour(hours[i].time)}</text>`).join('');
    return `<div class="chart-scroll"><svg class="temp-chart" style="width:${width}px" viewBox="0 0 ${width} ${height}" role="img" aria-label="Wykres temperatury z godzinami"><polyline points="${points}" class="chart-line"/>${guides}</svg></div>`;
  }

  private advice(snapshot: WeatherSnapshot): string {
    const c = snapshot.current;
    if (c.condition === 'thunderstorm') return 'Możliwa gwałtowna burza — sprawdź komunikaty dla swojego regionu przed wyjściem.';
    if (c.condition === 'heavy-rain') return 'Mocna ulewa — sprawdź lokalne komunikaty, a jeśli wychodzisz, wybierz wodoodporny zestaw.';
    if (c.condition === 'heavy-snow') return 'Intensywny śnieg — sprawdź komunikaty drogowe i zaplanuj spokojniejszą trasę.';
    if (c.condition === 'rain' || c.condition === 'drizzle' || c.precipMm > 0) return 'Kalosze, lekka peleryna i spacer nadal może być bardzo przyjemny.';
    if (c.condition === 'snow' || c.condition === 'sleet') return 'Ciepły szalik, rękawiczki i można ruszać podziwiać zimową pogodę.';
    if (c.condition === 'fog') return 'Jasna kurtka z odblaskiem pomoże bezpiecznie cieszyć się mglistym porankiem.';
    if ((c.uvIndex ?? 0) >= 6) return 'Słońce dopisuje — okulary, krem UV i coś do picia będą idealnym zestawem.';
    if (c.windKmh > 40) return 'Wiatroszczelna kurtka i pewnie zapięty kaptur uprzyjemnią wyjście.';
    if (c.tempC < 3) return 'Czapka, szalik i ciepłe warstwy zrobią z chłodu dobrego kompana spaceru.';
    return 'Warunki zachęcają do wyjścia — dobierz wygodne ubranie i korzystaj z dnia.';
  }

  private cloudLabel(value: number): string {
    if (value <= 12) return 'pełne słońce';
    if (value <= 45) return 'dużo słońca';
    if (value <= 88) return 'słońce zza chmur';
    return 'pełne chmury';
  }

  private animatedWeather(condition: WeatherCondition, cloudCover?: number): string {
    let kind = 'cloud-high';
    if (condition === 'thunderstorm') kind = 'thunder';
    else if (condition === 'rain' || condition === 'heavy-rain' || condition === 'drizzle') kind = 'rain';
    else if (condition === 'snow' || condition === 'heavy-snow' || condition === 'sleet') kind = 'snow';
    else if (condition === 'fog') kind = 'fog';
    else {
      const cover = cloudCover ?? (condition === 'clear' ? 5 : condition === 'partly-cloudy' ? 45 : condition === 'cloudy' ? 78 : 100);
      if (cover <= 12) kind = 'sunny';
      else if (cover <= 45) kind = 'cloud-low';
      else if (cover <= 88) kind = 'cloud-mid';
    }
    return `<span class="weather-anim ${kind}" aria-label="${escapeHtml(conditionLabel(condition))}"><i class="sun-rays"></i><i class="sun-disc"></i><i class="cloud-shape"></i><i class="rain-lines"><b></b><b></b><b></b></i><i class="lightning">ϟ</i><i class="snowflakes">✣ · ✣</i><i class="fog-lines">≋</i></span>`;
  }

  private pressureLabel(value: number): string {
    if (value < 995) return 'bardzo niskie';
    if (value < 1008) return 'niskie';
    if (value > 1028) return 'wysokie';
    return 'stabilne';
  }

  private uvLabel(value?: number): string {
    if (value == null) return 'brak danych';
    if (value < 3) return 'niski';
    if (value < 6) return 'umiarkowany';
    if (value < 8) return 'wysoki';
    return 'bardzo wysoki';
  }

  private meteopathScore(snapshot: WeatherSnapshot): { value: number; label: string; description: string } {
    const c = snapshot.current;
    let value = 1;
    value += Math.min(3, Math.round(Math.abs(c.pressureHpa - 1013) / 8));
    if (c.humidityPct > 75) value += 2;
    if (c.windKmh > 30) value += 2;
    if (c.precipMm > 0 || c.condition === 'thunderstorm') value += 2;
    value = Math.min(10, value);
    if (value <= 3) return { value, label: 'Niskie', description: 'Warunki atmosferyczne są łagodne dla osób wrażliwych.' };
    if (value <= 6) return { value, label: 'Umiarkowane', description: 'Możliwa jest lekka senność, rozdrażnienie lub ból głowy.' };
    return { value, label: 'Podwyższone', description: 'Zadbaj dziś o nawodnienie, odpoczynek i spokojniejsze tempo.' };
  }

  private setPanel(id: Section, html: string): void {
    const panel = this.root.querySelector<HTMLElement>(`[data-panel="${id}"]`);
    if (panel) panel.innerHTML = html;
  }

  private showSection(section: Section): void {
    this.root.querySelectorAll<HTMLElement>('[data-section]').forEach((el) => el.classList.toggle('active', el.dataset.section === section));
    this.root.querySelectorAll<HTMLElement>('[data-panel]').forEach((el) => el.classList.toggle('active', el.dataset.panel === section));
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
    if (updated && remembered) updated.textContent = `OFFLINE · zapamiętano ${hour(remembered.fetchedAt)}`;
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
    if (q.length < 2) { hint.textContent = 'Wpisz co najmniej 2 znaki'; list.innerHTML = ''; return; }
    hint.textContent = 'Szukam…';
    try {
      const cities = await this.weather.searchCities(q, this.city.country);
      if (generation !== this.searchGeneration) return;
      this.searchResults = cities.slice(0, 8);
      hint.textContent = cities.length ? `${cities.length} znalezionych miejsc` : 'Brak wyników';
      list.innerHTML = this.searchResults.map((city, i) => `<button data-city-index="${i}" type="button"><span class="result-pin">◆</span><div><strong>${escapeHtml(city.name)}</strong><small>${escapeHtml([city.admin, city.country].filter(Boolean).join(', '))}</small></div><b>›</b></button>`).join('');
    } catch {
      if (generation === this.searchGeneration) hint.textContent = 'Nie udało się wyszukać';
    }
  }

  private chooseSearchResult(index: number): void {
    const city = this.searchResults[index];
    if (city) void this.loadCity(city);
  }

  private async useGps(): Promise<void> {
    if (!navigator.geolocation) { this.showToast('Ta przeglądarka nie obsługuje GPS'); return; }
    this.showToast('Ustalam pozycję…');
    try {
      const point = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 }));
      const city = await this.weather.reverseGeocode({ lat: point.coords.latitude, lon: point.coords.longitude });
      await this.loadCity(city);
      this.showToast(`Ustawiono: ${city.name}`);
    } catch {
      this.showToast('Brak dostępu do lokalizacji');
    }
  }

  private useVoice(): void {
    if (!speechService.supported) { this.showToast('Rozpoznawanie mowy jest tu niedostępne'); return; }
    this.openSheet('search-sheet');
    this.showToast('Powiedz nazwę miejscowości…');
    speechService.listen({
      onState: () => undefined,
      onTranscript: (transcript) => {
        const place = extractPlace(transcript) || transcript;
        const input = this.root.querySelector<HTMLInputElement>('#city-search');
        if (input) input.value = place;
        void this.search(place);
      },
      onError: (message) => this.showToast(message),
    });
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
