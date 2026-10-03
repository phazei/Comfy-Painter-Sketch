/**
 * Vitest config: unit tests for pure logic only (geometry, value parsing).
 * Kept separate from `vite.config.ts` so the library-mode build settings
 * (output to ../js, externals) never apply to test runs.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // `?inline` CSS is empty in tests unless processed; layer-row rules are checked (layerNameClamp.test.ts).
    css: { include: [/layerRows\.css/] },
  },
});
