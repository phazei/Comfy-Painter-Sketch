/**
 * Vite build for the PainterSketch frontend.
 *
 * ComfyUI loads every `*.js` under the node pack's `WEB_DIRECTORY` (`../js`) as
 * an extension entry point, so this config must emit exactly ONE self-contained
 * ES module there: library mode, a single entry, dynamic imports inlined, no
 * CSS/asset files (CSS is imported with `?inline` and injected at runtime), and
 * no external sourcemap files.
 *
 * ComfyUI's own `app`/`api` objects are imported in source through the
 * `@comfy/scripts/*` aliases (types: `src/types/runtime/`) and rewritten
 * here to the runtime paths `../../scripts/app.js` / `../../scripts/api.js`,
 * which resolve relative to `/extensions/Comfy-Painter-Sketch/painter-sketch.js`.
 */
import { defineConfig } from "vite";

/** Source alias -> runtime URL (relative to the served bundle). */
const COMFY_RUNTIME_MODULES: Record<string, string> = {
  "@comfy/scripts/app.js": "../../scripts/app.js",
  "@comfy/scripts/api.js": "../../scripts/api.js",
};

export default defineConfig(({ mode }) => ({
  publicDir: false,
  build: {
    outDir: "../js", // resolved against this config's root (ui/)
    // js/ is owned entirely by this build: it must only ever contain the bundle.
    emptyOutDir: true,
    copyPublicDir: false,
    target: "es2022",
    // Inline maps only in dev/watch builds; never a separate .map file in js/.
    sourcemap: mode === "development" ? "inline" : false,
    // Readable committed output; the bundle is small and diffs stay reviewable.
    minify: false,
    reportCompressedSize: false,
    lib: {
      entry: "src/main.ts",
      formats: ["es"],
      fileName: () => "painter-sketch.js",
    },
    rollupOptions: {
      external: Object.keys(COMFY_RUNTIME_MODULES),
      output: {
        inlineDynamicImports: true,
        paths: COMFY_RUNTIME_MODULES,
      },
    },
  },
}));
