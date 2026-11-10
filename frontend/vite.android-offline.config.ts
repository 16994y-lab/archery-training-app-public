import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const policy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export default defineConfig({
  base: './',
  publicDir: false,
  envDir: false,
  envPrefix: 'GONGXINGJI_OFFLINE_BUILD_UNUSED_',
  define: {
    __GONGXINGJI_OFFLINE_ANDROID__: 'true',
  },
  plugins: [
    react(),
    {
      name: 'offline-android-shell',
      transformIndexHtml(html) {
        return {
          html: html
            .replace('弓行记 · Gongxingji', '弓行记 · 离线版')
            .replace('请检查网络后重试', '请重新打开应用'),
          tags: [{
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
            injectTo: 'head-prepend',
          }],
        };
      },
    },
  ],
  build: {
    target: 'chrome90',
    outDir: 'dist-offline-android',
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: { input: 'mobile.html' },
  },
});
