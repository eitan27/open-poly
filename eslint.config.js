import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // `.claude/worktrees/` holds agent worktrees — full checkouts of this repo,
  // INSIDE it. Without this eslint walks into each one and lints the whole
  // codebase again, so the warning count doubles per running agent and the
  // baseline stops meaning anything. Git (a4950c2) and vitest (3b5853c) each
  // had to learn the same thing.
  { ignores: ["dist", "node_modules", "mcp-server/node_modules", ".claude"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, reactHooks.configs["recommended-latest"]],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.worker, ...globals.node },
    },
    plugins: {
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  eslintConfigPrettier,
);
