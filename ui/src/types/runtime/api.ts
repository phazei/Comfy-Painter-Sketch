/**
 * Type-only stand-in for ComfyUI's `scripts/api.js`. See `./app.ts` for how
 * the `@comfy/scripts/*` alias maps to the runtime module. Never bundled.
 */

import type { ComfyApi } from "../comfy";

/** The ComfyUI API client singleton. */
export declare const api: ComfyApi;
