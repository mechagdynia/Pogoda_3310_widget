import './style.css';

import { FullWeatherApp } from './components/full_app';
import { WidgetUI } from './components/widget_ui';
import { LcdRenderer } from './graphics/lcd_renderer';
import { weatherService } from './services/weather_service';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Brak kontenera aplikacji');

const params = new URLSearchParams(location.search);
const widgetMode = params.get('view') === 'widget' || params.has('widget');
let dispose: (() => void) | undefined;

if (widgetMode) {
  document.body.classList.add('widget-mode');
  root.innerHTML = `
    <button class="widget-launcher" type="button" aria-label="Otwórz pełną aplikację Pogoda 3310">
      <span class="widget-lcd" id="lcd-wrap">
        <canvas id="lcd" width="416" height="256"></canvas>
      </span>
    </button>`;
  const canvas = root.querySelector<HTMLCanvasElement>('#lcd');
  const host = root.querySelector<HTMLElement>('#lcd-wrap');
  const launcher = root.querySelector<HTMLButtonElement>('.widget-launcher');
  if (!canvas || !host || !launcher) throw new Error('Brak elementów widgetu');

  const lcd = new LcdRenderer(canvas, host);
  const widget = new WidgetUI(lcd, weatherService, { autoLoad: true });
  const ro = new ResizeObserver(() => lcd.resize());
  ro.observe(host);
  launcher.addEventListener('click', () => {
    const url = new URL(location.href);
    url.searchParams.delete('view');
    url.searchParams.delete('widget');
    location.href = url.toString();
  });
  widget.start();
  dispose = () => {
    ro.disconnect();
    widget.dispose();
  };
} else {
  const app = new FullWeatherApp(root, weatherService);
  app.start();
  dispose = () => app.dispose();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => undefined);
  });
}

window.addEventListener('pagehide', (event: PageTransitionEvent) => {
  if (!event.persisted) dispose?.();
});
