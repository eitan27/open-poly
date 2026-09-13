import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
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

// OCCT is a large WASM module loaded in a Web Worker; exclude it from dep
// pre-bundling and emit workers as ES modules so the `?url` wasm import resolves.
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [react(), versionStamp(), thirdPartyLicenses()],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["replicad-opencascadejs", "@salusoft89/planegcs"] },
});
