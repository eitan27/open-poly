import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { thirdPartyLicenses } from "./scripts/third-party-licenses";

// A build id that changes on every build. It's baked into the app bundle (as
// `__BUILD_ID__`) AND emitted to `dist/version.json`, so the running app can
// poll the deployed version.json and prompt a refresh when a newer build is
// live (see src/useVersionCheck.ts).
const BUILD_ID = new Date().toISOString();

// Emits version.json into the build output alongside the hashed assets.
function versionStamp(): Plugin {
  return {
    name: "version-stamp",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ version: BUILD_ID }),
      });
    },
  };
}

// The offline service worker (src/sw.ts) and install manifest; registered in
// src/pwa.ts. injectManifest, not a generated worker: pages are network-first
// with a fallback that must not be cached, which the generated one can't express.
// The precache list covers everything the app needs to boot and model with no
// connection — the OCCT wasm alone is ~11 MB, past workbox's 2 MB default, hence
// the raised cap. version.json is never precached: it's how a new deploy is noticed.
const pwa = VitePWA({
  strategies: "injectManifest",
  srcDir: "src",
  filename: "sw.ts",
  injectRegister: false,
  manifest: {
    name: "Open Poly",
    short_name: "Open Poly",
    description: "Free, open-source parametric CAD in your browser.",
    start_url: "/",
    display: "standalone",
    background_color: "#14161b",
    theme_color: "#14161b",
    icons: [
      { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
      { src: "/favicon.png", sizes: "512x512", type: "image/png" },
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  },
  injectManifest: {
    globPatterns: ["**/*.{js,css,html,wasm,svg,png,ttf,txt}"],
    globIgnores: ["og.png", "robots.txt"],
    maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
  },
});

// OCCT is a large WASM module loaded in a Web Worker; exclude it from dep
// pre-bundling and emit workers as ES modules so the `?url` wasm import resolves.
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [react(), versionStamp(), thirdPartyLicenses(), pwa],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["replicad-opencascadejs", "@salusoft89/planegcs"] },
});
