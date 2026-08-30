/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
    // e2e/ holds Playwright specs (different test runner, different
    // `test`/`expect`) and .stryker-tmp/ holds mutation-testing sandboxes -
    // both look like test files to Vitest's default glob and must never be
    // picked up here, or they fail (wrong API) or double-run real specs.
    exclude: ["**/node_modules/**", "**/e2e/**", "**/.stryker-tmp/**"],
  },
});
