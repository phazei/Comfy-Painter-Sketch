/**
 * Reads the "Defaults" settings (`maskDefaults.ts`, `pressureDefaults.ts`)
 * through the guarded settings accessor. Cheap (a few store lookups), so
 * callers read at the moment they need a value instead of caching; a missing
 * settings API or junk values fall back to the built-in defaults.
 */

import type { MaskStyle } from "../document/create";
import { readSetting } from "../widget/comfyApi";
import { firstMaskStyleFrom } from "./maskDefaults";
import type { PressureDefaults } from "./pressureDefaults";
import { pressureDefaultsFrom } from "./pressureDefaults";
import type { SampleDefaults } from "./sampleDefaults";
import { sampleDefaultsFrom } from "./sampleDefaults";

/**
 * Setting reader that never throws (a settings store that rejects an id
 * reads as "unset").
 * @param id - Setting id.
 * @returns Stored value, or `undefined`.
 */
function safeRead(id: string): unknown {
  try {
    return readSetting(id);
  } catch {
    return undefined;
  }
}

/**
 * Style of a document's first mask layer from the user's settings.
 * @returns Colour + overlay opacity.
 */
export function readFirstMaskStyle(): MaskStyle {
  return firstMaskStyleFrom(safeRead);
}

/**
 * Initial brush/eraser pressure options from the user's settings.
 * @returns Pressure defaults.
 */
export function readPressureDefaults(): PressureDefaults {
  return pressureDefaultsFrom(safeRead);
}

/**
 * Initial bucket / magic wand sample sources from the user's settings.
 * @returns Sample defaults.
 */
export function readSampleDefaults(): SampleDefaults {
  return sampleDefaultsFrom(safeRead);
}
