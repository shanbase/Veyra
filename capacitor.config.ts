import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'chat.veyra.mobile',
  appName: 'Veyra',
  webDir: 'dist',
  server: {
    // The APK is a native shell around the deployed Veyra web app and API.
    // Primary host; FailoverWebViewClient retries the Vercel deployment if
    // the primary fails to load (see scripts/configure-android-updater.mjs).
    url: 'https://veyra.go.altare.global',
    cleartext: false,
  },
};

export default config;
