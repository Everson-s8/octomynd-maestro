import { defineConfig } from "vite";

// The Tauri webview loads the built files from disk; keep asset URLs relative
// and never reach the network for fonts or scripts.
export default defineConfig({
  base: "./",
  clearScreen: false,
  build: {
    outDir: "dist",
    target: "es2022",
    assetsInlineLimit: 0
  }
});
