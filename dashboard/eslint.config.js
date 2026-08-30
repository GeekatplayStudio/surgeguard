import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { globalIgnores } from "eslint/config";

export default tseslint.config([
  // .stryker-tmp holds Stryker's own mutation-testing sandboxes (full
  // project mirrors, one per worker) and reports/ holds its HTML output -
  // neither is source, and .stryker-tmp's sandboxes even carry their own
  // tsconfig that collides with this one if ESLint is ever pointed at them.
  globalIgnores(["dist", ".stryker-tmp", "reports"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat["recommended-latest"],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // The dashboard intentionally polls the API on an interval from a
      // `useEffect` (see App.tsx); the resulting setState calls happen
      // asynchronously inside `refresh()`, not synchronously in the effect
      // body. Downgraded to match oxlint's severity for the same finding
      // rather than restructuring the polling architecture.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);
