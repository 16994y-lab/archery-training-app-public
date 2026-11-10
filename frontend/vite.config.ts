import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build: { rollupOptions: { input: { main: "index.html", recovery: "auth/account-recovery.html" } } },
  server: {
    proxy: {
      "/api": loadEnv(mode, process.cwd(), "VITE_API_PROXY").VITE_API_PROXY || "http://127.0.0.1:8000",
    },
  },
}));
