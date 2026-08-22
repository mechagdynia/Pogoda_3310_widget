const DEFAULT_APP_URL = 'https://mechagdynia.github.io/Pogoda_3310_widget/';
const appUrl = args.widgetParameter?.trim() || DEFAULT_APP_URL;

if (!config.runsInWidget) {
  Safari.openInApp(appUrl, false);
  Script.complete();
  return;
}

const fallback = { latitude: 52.2297, longitude: 21.0122, city: 'WARSZAWA' };
let place = fallback;
try {
  Location.setAccuracyToThreeKilometers();
  const location = await Location.current();
  const names = await Location.reverseGeocode(location.latitude, location.longitude, 'pl_PL');
  place = {
    latitude: location.latitude,
    longitude: location.longitude,
    city: (names[0]?.locality || names[0]?.subLocality || 'MOJE MIEJSCE').toUpperCase(),
  };
} catch (_) {}

const endpoint = new URL('https://api.open-meteo.com/v1/forecast');
endpoint.searchParams.set('latitude', String(place.latitude));
endpoint.searchParams.set('longitude', String(place.longitude));
endpoint.searchParams.set('timezone', 'auto');
endpoint.searchParams.set('forecast_hours', '24');
endpoint.searchParams.set('current', 'temperature_2m,weather_code');
endpoint.searchParams.set('hourly', 'temperature_2m,weather_code');

let data;
let offline = false;
const files = FileManager.local();
const cacheFile = files.joinPath(files.documentsDirectory(), 'pogoda3310-last-weather.json');
try {
  data = await new Request(endpoint.toString()).loadJSON();
  files.writeString(cacheFile, JSON.stringify(data));
} catch (_) {
  offline = true;
  data = files.fileExists(cacheFile)
    ? JSON.parse(files.readString(cacheFile))
    : { current: { temperature_2m: 0, weather_code: -1, time: new Date().toISOString() }, hourly: { time: [], temperature_2m: [] } };
}

const condition = (code) => {
  if (code === 0) return 'CZYSTO';
  if (code <= 3) return 'CHMURY';
  if (code <= 48) return 'MGŁA';
  if (code <= 67) return 'DESZCZ';
  if (code <= 77) return 'ŚNIEG';
  if (code <= 82) return 'ULEWA';
  if (code <= 86) return 'ŚNIEG';
  if (code >= 95) return 'BURZA';
  return 'BRAK DANYCH';
};

const widget = new ListWidget();
widget.url = appUrl;
widget.setPadding(11, 12, 10, 12);
const gradient = new LinearGradient();
gradient.colors = [new Color('#afc98c'), new Color('#8faa72')];
gradient.locations = [0, 1];
widget.backgroundGradient = gradient;

const ink = new Color('#173117');
const header = widget.addStack();
header.centerAlignContent();
const signal = header.addText(offline ? '×' : '▂▄▆');
signal.font = Font.boldMonospacedSystemFont(8);
signal.textColor = ink;
header.addSpacer();
const brand = header.addText('NOK♥A');
brand.font = Font.boldMonospacedSystemFont(11);
brand.textColor = ink;
header.addSpacer();
const battery = header.addText(new Date().getMinutes() % 2 ? '▯' : '▱');
battery.font = Font.boldMonospacedSystemFont(11);
battery.textColor = ink;

widget.addSpacer(5);
const city = widget.addText(place.city.slice(0, 16));
city.font = Font.boldMonospacedSystemFont(11);
city.textColor = ink;

const main = widget.addStack();
main.centerAlignContent();
const temp = main.addText(`${Math.round(data.current.temperature_2m)}°`);
temp.font = Font.boldMonospacedSystemFont(config.widgetFamily === 'small' ? 34 : 42);
temp.textColor = ink;
main.addSpacer();
const label = main.addText(condition(data.current.weather_code));
label.font = Font.boldMonospacedSystemFont(9);
label.textColor = ink;

widget.addSpacer();
const currentMs = Date.parse(data.current.time || new Date().toISOString());
const values = data.hourly.time.map((time, i) => ({
  raw: String(time),
  time: String(time).slice(11, 13),
  temp: Math.round(data.hourly.temperature_2m[i]),
})).filter((value) => Number(value.time) % 3 === 0 && Date.parse(value.raw) > currentMs).slice(0, 7);
const temps = widget.addText(values.map((value) => `${String(value.temp).padStart(2, ' ')}°`).join(' '));
temps.font = Font.boldMonospacedSystemFont(config.widgetFamily === 'small' ? 6 : 9);
temps.textColor = ink;
temps.lineLimit = 1;
const hours = widget.addText(values.map((value) => `${value.time} `).join(' '));
hours.font = Font.boldMonospacedSystemFont(config.widgetFamily === 'small' ? 5 : 8);
hours.textColor = ink;
hours.lineLimit = 1;

widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
Script.setWidget(widget);
Script.complete();
