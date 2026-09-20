import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  // BrowserRouter is used by the dashboard. Absolute asset URLs keep direct
  // deep links such as /tasks/1/logs from looking for JS under that route.
  base: "/",
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4788,
    proxy: {
      "/api": "http://127.0.0.1:4787"
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
