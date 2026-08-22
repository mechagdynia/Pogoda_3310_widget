/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Optional WeatherAPI.com key (3rd provider in the cascade).
   * Falls back to the bundled demo key when unset.
   */
  readonly VITE_WEATHERAPI_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Vite 5 nie deklaruje już importów CSS — dodajemy własną deklarację. */
declare module '*.css';
