export type AppLanguage = 'pl' | 'en';

export function detectLanguage(): AppLanguage {
  const override = new URLSearchParams(location.search).get('lang')?.toLowerCase();
  if (override === 'pl' || override === 'en') return override;
  const preferred = navigator.languages?.[0] ?? navigator.language ?? 'en';
  return preferred.toLowerCase().startsWith('pl') ? 'pl' : 'en';
}

export function localeFor(language: AppLanguage): string {
  return language === 'pl' ? 'pl-PL' : 'en-GB';
}

export function tx(language: AppLanguage, polish: string, english: string): string {
  return language === 'pl' ? polish : english;
}

export function formatHour(iso: string, language: AppLanguage): string {
  const parsed = new Date(iso);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleTimeString(localeFor(language), { hour: '2-digit', minute: '2-digit' });
  }
  return iso.match(/T(\d{2}):?(\d{2})?/)?.slice(1).filter(Boolean).join(':') ?? '--';
}

export function formatShortDate(date: Date | string, language: AppLanguage): string {
  const parsed = typeof date === 'string' ? new Date(date) : date;
  return parsed.toLocaleDateString(localeFor(language), { day: 'numeric', month: 'short' });
}
