import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import publicConfig from './mobile-public-config.json';

const config = publicConfig as Record<string, unknown>;
const flags = {
  VITE_NATIVE_SESSION_RELAY_READY: 'nativeSessionRelayReady',
  VITE_PHONE_OTP_READY: 'phoneOtpReady',
  VITE_COMMUNITY_TEST_ONLY: 'communityTestOnly',
  VITE_EMAIL_ENROLLMENT_READY: 'emailEnrollmentReady',
  VITE_EMAIL_OTP_READY: 'emailOtpReady',
  VITE_EXISTING_EMAIL_OTP_LOGIN_READY: 'existingEmailOtpLoginReady',
};

// An independent entry: this build does not load the personal training store,
// change the mobile release, or package unrelated public/model assets.
export default defineConfig({
  plugins: [react()],
  define: Object.fromEntries(Object.entries(flags).map(([name, key]) =>
    ['import.meta.env.' + name, JSON.stringify(String(config[key] === true))])),
  base: './',
  publicDir: false,
  build: {
    outDir: 'dist-workspace',
    emptyOutDir: true,
    target: 'chrome96',
    rollupOptions: { input: 'workspace.html' },
  },
  server: {
    host: '127.0.0.1',
    port: 5193,
    strictPort: true,
    proxy: { '/api': process.env.VITE_API_PROXY ?? 'http://127.0.0.1:8000' },
  },
});
