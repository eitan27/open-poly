import { configDefaults, defineConfig, type Plugin } from "vitest/config";
import path from "node:path";

// Under vitest (node), a `foo.wasm?url` import resolves to a server-style
// absolute path ("/node_modules/...") that emscripten's locateFile can't read
// from the filesystem. Rewrite the planegcs wasm `?url` import to a real
// absolute path so the constraint solver can run in unit tests.
function wasmUrlForNode(): Plugin {
  const abs = path.resolve(__dirname, "node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm");
  return {
    name: "wasm-url-for-node",
    enforce: "pre",
    resolveId(id) {
      if (id.includes("planegcs.wasm") && id.includes("?url")) return "\0planegcs-wasm-url";
    },
    load(id) {
      if (id === "\0planegcs-wasm-url") return `export default ${JSON.stringify(abs)}`;
    },
  };
}

export default defineConfig({
  plugins: [wasmUrlForNode()],
  test: {
    environment: "node",
    // Agent worktrees live under `.claude/worktrees/` — inside the repo, so the
    // default glob walks into each one and runs every suite again. Two of them
    // once turned 797 tests into 2423 and the inflated number looked like a win.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
