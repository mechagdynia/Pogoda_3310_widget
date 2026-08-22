import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the Android APK wrapper.
 * `webDir` points at the Vite build output. The PWA + service worker are
 * loaded natively inside the WebView, giving a true offline-capable APK.
 */
const config: CapacitorConfig = {
  appId: 'pl.mechagdynia.pogoda3310',
  appName: 'Pogoda 3310',
  webDir: 'dist',
  backgroundColor: '#0f380f',
  server: {
    androidScheme: 'https'
  },
  android: {
    allowMixedContent: false
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#0f380f'
    }
  }
};

export default config;
