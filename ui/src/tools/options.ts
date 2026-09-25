/**
 * Declarative tool options: each tool lists option descriptors (number,
 * toggle, select) and the options bar renders them generically -- no
 * per-tool UI code. Numbers are described in DISPLAY units (e.g. hardness
 * 0..100 %) with a `scale` to the stored value (0..1). Pure helpers here do
 * clamping, step snapping, formatting and the slider curve.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** A stored option value. */
export type OptionValue = number | boolean | string;

/** Stored option values of a tool, by key. */
export type OptionValues = Record<string, OptionValue>;

/** Fields shared by every descriptor. */
interface BaseOption {
  /** Key in the tool's option values. */
  key: string;
  /** Short label shown in the bar. */
  label: string;
  /** Tooltip (include the shortcut, if any). */
  title?: string;
  /**
   * Options with different groups get a divider between them. A group
   * listed in {@link ToolOptions.groups} is collapsed behind one button.
   */
  group?: string;
  /** Shown dimmed unless at least one of these toggles is on. */
  dependsOn?: readonly string[];
}

/** Numeric option (label + number field, scrubby label, slider popover). */
export interface NumberOption extends BaseOption {
  kind: "number";
  /** Display-unit range and step. */
  min: number;
  max: number;
  step: number;
  /** Display suffix, e.g. `"px"`, `"%"`. */
  unit?: string;
  /** Stored value = display / scale (default 1). */
  scale?: number;
  /** Slider mapping: `"pow"` gives fine control at the low end (sizes). */
  curve?: "linear" | "pow";
}

/** Boolean option (pill toggle). */
export interface ToggleOption extends BaseOption {
  kind: "toggle";
}

/** Choice among fixed string values. */
export interface SelectOption extends BaseOption {
  kind: "select";
  choices: ReadonlyArray<{ value: string; label: string }>;
}

/** Any option descriptor. */
export type OptionDescriptor = NumberOption | ToggleOption | SelectOption;

/**
 * Descriptors sharing `group === id` shown behind one icon button (which
 * opens them in a popover) instead of inline in the bar.
 */
export interface OptionGroup {
  /** Matches {@link BaseOption.group} of the member descriptors. */
  id: string;
  /** Icon name (`ui/icons.ts`). */
  icon: string;
  /** Button tooltip / popover title. */
  title: string;
  /** The button shows an "active" tint while any of these toggles is on. */
  activeWhen?: readonly string[];
}

/** One entry of the options bar layout ({@link layoutOptions}). */
export type OptionBarItem =
  | { kind: "control"; desc: OptionDescriptor }
  | { kind: "separator" }
  | { kind: "group"; group: OptionGroup; descriptors: OptionDescriptor[] };

/** Editable options of a tool, as seen by the UI and shortcuts. */
export interface ToolOptions {
  /** Descriptors in display order. */
  readonly descriptors: readonly OptionDescriptor[];
  /** Groups collapsed behind a button (default none). */
  readonly groups?: readonly OptionGroup[];
  /**
   * Stored value of an option.
   * @param key - Option key.
   * @returns Value, or `undefined` if the tool has no such option.
   */
  get(key: string): OptionValue | undefined;
  /**
   * Set an option; numbers are clamped/snapped, wrong types ignored.
   * @param key - Option key.
   * @param value - Stored (not display) value.
   * @returns `true` if the value changed.
   */
  set(key: string, value: OptionValue): boolean;
}

/** Exponent of the `"pow"` slider curve. */
const POW_CURVE = 2;

// ── Number helpers (display units) ────────────────────────────────────────────

/**
 * Decimal places implied by a step (0.05 -> 2).
 * @param step - Step size.
 * @returns Decimal places (0..6).
 */
export function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  for (let d = 0; d <= 6; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-9) return d;
  return 6;
}

/**
 * Clamp to the range and snap to the step grid (anchored at `min`).
 * @param desc - Number descriptor.
 * @param display - Display value.
 * @returns Valid display value (`min` for non-finite input).
 */
export function clampDisplay(desc: NumberOption, display: number): number {
  if (!Number.isFinite(display)) return desc.min;
  const step = desc.step > 0 ? desc.step : 1;
  const snapped = desc.min + Math.round((display - desc.min) / step) * step;
  const clamped = Math.min(desc.max, Math.max(desc.min, snapped));
  return Number(clamped.toFixed(stepDecimals(step)));
}

/**
 * Stored value -> display value (clamped, snapped).
 * @param desc - Number descriptor.
 * @param value - Stored value.
 * @returns Display value.
 */
export function toDisplay(desc: NumberOption, value: number): number {
  return clampDisplay(desc, value * (desc.scale ?? 1));
}

/**
 * Display value -> stored value (clamped, snapped first).
 * @param desc - Number descriptor.
 * @param display - Display value.
 * @returns Stored value.
 */
export function fromDisplay(desc: NumberOption, display: number): number {
  return clampDisplay(desc, display) / (desc.scale ?? 1);
}

/**
 * Display text without the unit ("0.25", "80").
 * @param desc - Number descriptor.
 * @param display - Display value.
 * @returns Formatted number.
 */
export function formatDisplay(desc: NumberOption, display: number): string {
  return clampDisplay(desc, display).toFixed(stepDecimals(desc.step));
}

/**
 * Slider position (0..1) -> display value, through the descriptor's curve.
 * @param desc - Number descriptor.
 * @param t - Slider position 0..1.
 * @returns Display value (clamped, snapped).
 */
export function sliderToDisplay(desc: NumberOption, t: number): number {
  const u = Math.min(1, Math.max(0, t));
  const k = desc.curve === "pow" ? Math.pow(u, POW_CURVE) : u;
  return clampDisplay(desc, desc.min + k * (desc.max - desc.min));
}

/**
 * Display value -> slider position (0..1); inverse of {@link sliderToDisplay}.
 * @param desc - Number descriptor.
 * @param display - Display value.
 * @returns Slider position 0..1.
 */
export function displayToSlider(desc: NumberOption, display: number): number {
  const range = desc.max - desc.min;
  if (range <= 0) return 0;
  const k = (clampDisplay(desc, display) - desc.min) / range;
  return desc.curve === "pow" ? Math.pow(k, 1 / POW_CURVE) : k;
}

// ── Generic option set ────────────────────────────────────────────────────────

/**
 * Validate a value for a descriptor.
 * @param desc - Descriptor.
 * @param value - Candidate stored value.
 * @returns The value to store, or `undefined` if the type is wrong.
 */
export function coerceOption(desc: OptionDescriptor, value: OptionValue): OptionValue | undefined {
  switch (desc.kind) {
    case "number":
      return typeof value === "number" ? fromDisplay(desc, value * (desc.scale ?? 1)) : undefined;
    case "toggle":
      return typeof value === "boolean" ? value : undefined;
    case "select":
      return typeof value === "string" && desc.choices.some((c) => c.value === value) ? value : undefined;
  }
}

/**
 * Whether a descriptor is currently relevant (its `dependsOn` toggles).
 * @param desc - Descriptor.
 * @param get - Value lookup.
 * @returns `true` when enabled.
 */
export function isOptionEnabled(desc: OptionDescriptor, get: (key: string) => OptionValue | undefined): boolean {
  if (!desc.dependsOn?.length) return true;
  return desc.dependsOn.some((key) => get(key) === true);
}

// ── Bar layout ────────────────────────────────────────────────────────────────

/**
 * Lay descriptors out for the options bar: collapsed groups become one
 * `group` item at the position of their first member; a `separator` goes
 * between neighbouring items of different groups.
 * @param descriptors - Descriptors in display order.
 * @param groups - Groups to collapse.
 * @returns Bar items in display order.
 */
export function layoutOptions(
  descriptors: readonly OptionDescriptor[],
  groups: readonly OptionGroup[] = [],
): OptionBarItem[] {
  const collapsed = new Map(groups.map((g) => [g.id, g]));
  const items: OptionBarItem[] = [];
  const emitted = new Map<string, OptionDescriptor[]>();
  let lastGroup: string | undefined;
  for (const desc of descriptors) {
    const group = desc.group !== undefined ? collapsed.get(desc.group) : undefined;
    if (group) {
      const members = emitted.get(group.id);
      if (members) {
        members.push(desc);
        continue;
      }
    }
    if (items.length > 0 && desc.group !== lastGroup) items.push({ kind: "separator" });
    lastGroup = desc.group;
    if (group) {
      const members = [desc];
      emitted.set(group.id, members);
      items.push({ kind: "group", group, descriptors: members });
    } else {
      items.push({ kind: "control", desc });
    }
  }
  return items;
}

/**
 * Whether a group button shows its "active" tint.
 * @param group - Group.
 * @param get - Value lookup.
 * @returns `true` when any `activeWhen` toggle is on.
 */
export function isGroupActive(group: OptionGroup, get: (key: string) => OptionValue | undefined): boolean {
  return (group.activeWhen ?? []).some((key) => get(key) === true);
}

// ── Option set ────────────────────────────────────────────────────────────────

/**
 * {@link ToolOptions} over a plain values object (edited in place).
 */
export class OptionSet implements ToolOptions {
  private readonly byKey = new Map<string, OptionDescriptor>();

  /**
   * @param descriptors - Descriptors in display order.
   * @param values - Values object; only descriptor keys are ever written.
   * @param groups - Groups collapsed behind a button in the bar.
   */
  constructor(
    readonly descriptors: readonly OptionDescriptor[],
    private readonly values: OptionValues,
    readonly groups: readonly OptionGroup[] = [],
  ) {
    for (const desc of descriptors) this.byKey.set(desc.key, desc);
  }

  /** @inheritdoc */
  get(key: string): OptionValue | undefined {
    return this.byKey.has(key) ? this.values[key] : undefined;
  }

  /** @inheritdoc */
  set(key: string, value: OptionValue): boolean {
    const desc = this.byKey.get(key);
    if (!desc) return false;
    const next = coerceOption(desc, value);
    if (next === undefined || next === this.values[key]) return false;
    this.values[key] = next;
    return true;
  }
}
