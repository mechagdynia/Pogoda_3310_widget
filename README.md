# Pogoda_3310_widget

## Polski

Pikselowy widget pogodowy i pełna aplikacja PWA inspirowana ekranem Nokii 3310. Łączy prognozę na żywo, tryb offline, GPS, wyszukiwanie głosowe i animowane retro ikony na ekranie LCD.

### Linki

- Aplikacja: `https://mechagdynia.github.io/Pogoda_3310_widget/`
- Widget webowy: `https://mechagdynia.github.io/Pogoda_3310_widget/?view=widget`
- Scriptable: `scriptable/Pogoda_3310_widget.js`

### Funkcje

- animowany ekran LCD 104×64,
- prognoza godzinowa i do 14 dni,
- GPS, wyszukiwanie i wprowadzanie miejscowości głosem,
- trwała prognoza offline,
- odświeżanie widgetu co 15 minut i po wybudzeniu,
- strefa Meteopaty,
- trzy skórki: 3310, Aurora i Radar,
- PWA oraz projekt Android/Capacitor.

## English

A pixel-art weather widget and full PWA inspired by the Nokia 3310 display. It combines live forecasts, offline fallback, GPS, voice search, and animated retro weather icons on an LCD screen.

### Links

- App: `https://mechagdynia.github.io/Pogoda_3310_widget/`
- Web widget: `https://mechagdynia.github.io/Pogoda_3310_widget/?view=widget`
- Scriptable: `scriptable/Pogoda_3310_widget.js`

### Features

- animated 104×64 LCD screen,
- hourly and 14-day forecasts,
- GPS, place search, and voice input,
- persistent offline forecast,
- widget refresh every 15 minutes and after wake-up,
- weather-sensitivity dashboard,
- three themes: 3310, Aurora, and Radar,
- PWA and Android/Capacitor project.

## Local development / Praca lokalna

```bash
npm ci
npm run dev
```

Build produkcyjny:

```bash
npm run build
```

## Android release / Wydanie Android

Workflow `.github/workflows/release.yml` requires these secrets / wymaga sekretów:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The release is started manually from Actions / Release uruchamia się ręcznie z zakładki Actions.
