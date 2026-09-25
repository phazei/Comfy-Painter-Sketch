/**
 * Console logging with the project prefix. Use for actionable warnings only.
 */

const PREFIX = "[PainterSketch]";

/** Prefixed console helpers. */
export const log = {
  /**
   * Log a warning.
   * @param args - Values to log after the prefix.
   */
  warn: (...args: unknown[]): void => console.warn(PREFIX, ...args),
  /**
   * Log an error.
   * @param args - Values to log after the prefix.
   */
  error: (...args: unknown[]): void => console.error(PREFIX, ...args),
};
