import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// OCCT is a large WASM module loaded in a Web Worker; exclude it from dep
// pre-bundling and emit workers as ES modules so the `?url` wasm import resolves.
export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
});
