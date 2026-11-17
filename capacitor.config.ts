import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'chat.veyra.mobile',
  appName: 'Veyra',
  webDir: 'dist',
  server: {
    // The APK is a native shell around the deployed Veyra web app and API.
    // Vercel is primary (edge functions near each user + regional DB read
    // replicas); FailoverWebViewClient retries the Altare deployment if the
    // Vercel host fails to load (see scripts/configure-android-updater.mjs).
    url: 'https://veyra-pink-mu.vercel.app',
    cleartext: false,
  },
};

export default config;
