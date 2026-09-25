/**
 * Type-only stand-in for ComfyUI's `scripts/app.js`.
 *
 * Source imports `@comfy/scripts/app.js`; `tsconfig.json` `paths` points the
 * type checker here, and `vite.config.ts` externalizes the specifier and
 * rewrites it to the runtime path `../../scripts/app.js`. This file is never
 * bundled. (Ambient `declare module` can't be used: TypeScript forbids
 * relative specifiers there.)
 */

import type { ComfyApp } from "../comfy";

/** The ComfyUI application singleton. */
export declare const app: ComfyApp;
