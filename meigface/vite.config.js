import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [sveltekit()],

  // Prevent Vite from obscuring Rust errors in the console
  clearScreen: false,

  server: {
    // Tauri expects a fixed port — fail if unavailable
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Ignore src-tauri to avoid triggering Vite rebuilds on Rust changes
      ignored: ["**/src-tauri/**"],
    },
  },

  // Allow MediaPipe to use SharedArrayBuffer where available
  optimizeDeps: {
    exclude: ["@tauri-apps/api"],
  },
}));