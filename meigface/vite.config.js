import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
    plugins: [
    // SvelteKit 3 takes its configuration here (svelte.config.js is no longer read).
    // Tauri has no Node.js server for SSR, so adapter-static with an index.html
    // fallback builds the app in SPA mode.
    // See: https://svelte.dev/docs/kit/single-page-apps
    // See: https://v2.tauri.app/start/frontend/sveltekit/
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ fallback: "index.html" }),
    }),
  ],

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
