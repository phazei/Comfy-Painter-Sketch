/**
 * Minimal structural types for the parts of the ComfyUI frontend we touch.
 *
 * The official `@comfyorg/comfyui-frontend-types` package ships without its
 * `index.d.ts` for every release from 1.50 through 1.56 (the tarball holds only
 * LICENSE + package.json), so we declare just what we use. Shapes were checked
 * against ComfyUI_frontend 1.55.2 source (`src/scripts/app.ts`, `api.ts`,
 * `domWidget.ts`, `types/comfy.ts`, `types/litegraph-augmentation.d.ts`).
 *
 * Everything here is type-only; nothing is emitted.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Execution output
// ═══════════════════════════════════════════════════════════════════════════

/** One file reference in a node's execution output (`/view` query fields). */
export interface ResultItem {
  filename?: string;
  subfolder?: string;
  type?: string;
}

/** A node's `ui` output as received in `executed` / `onExecuted`. */
export interface NodeExecutionOutput {
  images?: (ResultItem | null)[];
  animated?: boolean[];
  [key: string]: unknown;
}

/** Payload of the api `executed` event. */
export interface ExecutedWsMessage {
  node: string;
  display_node?: string;
  prompt_id?: string;
  output: NodeExecutionOutput;
  merge?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Widgets
// ═══════════════════════════════════════════════════════════════════════════

/** Options bag shared by all widgets (subset). */
export interface IWidgetOptions {
  socketless?: boolean;
  serialize?: boolean;
  [key: string]: unknown;
}

/** A LiteGraph widget (subset). */
export interface IBaseWidget {
  name: string;
  type: string;
  value: unknown;
  options: IWidgetOptions;
  hidden?: boolean;
  serialize?: boolean;
  callback?: (value: unknown, ...rest: unknown[]) => void;
  serializeValue?: (node: LGraphNode, index: number) => Promise<unknown> | unknown;
  onRemove?: () => void;
}

/** Options accepted by `node.addDOMWidget` (see frontend `src/scripts/domWidget.ts`). */
export interface DOMWidgetOptions<V extends object | string> extends IWidgetOptions {
  hideOnZoom?: boolean;
  selectOn?: string[];
  getValue?: () => V;
  setValue?: (value: V) => void;
  getMinHeight?: () => number;
  getMaxHeight?: () => number;
  getHeight?: () => string | number;
  margin?: number;
  afterResize?: (node: LGraphNode) => void;
  onHide?: (widget: DOMWidget<HTMLElement, V>) => void;
}

/** A widget wrapping a real DOM element. */
export interface DOMWidget<T extends HTMLElement, V extends object | string> extends IBaseWidget {
  element: T;
  value: V;
  options: DOMWidgetOptions<V>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Graph + nodes
// ═══════════════════════════════════════════════════════════════════════════

/** An input slot (subset). */
export interface INodeInputSlot {
  name: string;
  type: unknown;
  link: number | null;
}

/** A graph or subgraph (subset). */
export interface LGraph {
  id: string;
  /** `false` for subgraphs; used to build node locator ids. */
  isRootGraph?: boolean;
  /** The root graph (the graph itself for the root; the parent root for subgraphs). */
  rootGraph?: LGraph;
  /** Marks the graph as changed (what `BaseWidget.setValue` calls after a user edit). */
  incrementVersion?(): void;
}

/** Callback signature of `LGraphNode.onConnectionsChange`. */
export type ConnectionsChangeCallback = (
  type: number,
  index: number,
  isConnected: boolean,
  linkInfo: unknown,
  slot: unknown,
) => void;

/** A LiteGraph node instance (subset of `LGraphNode` + ComfyUI augmentation). */
export interface LGraphNode {
  id: string | number;
  type?: string;
  comfyClass?: string;
  graph: LGraph | null;
  inputs: INodeInputSlot[];
  widgets?: IBaseWidget[];
  size: [number, number];
  /** Frontend-only nodes (legacy Reroute, Primitive, ...). */
  isVirtualNode?: boolean;
  /** Legacy preview images of the node, if any. */
  imgs?: HTMLImageElement[];
  /** Nodes 2.0: skip rendering execution output images under the node. */
  hideOutputImages?: boolean;
  constructor: { comfyClass?: string; nodeData?: { name?: string } };

  setSize(size: [number, number]): void;
  getInputNode(slot: number): LGraphNode | null;
  addDOMWidget<T extends HTMLElement, V extends object | string>(
    name: string,
    type: string,
    element: T,
    options?: DOMWidgetOptions<V>,
  ): DOMWidget<T, V>;

  onNodeCreated?(this: LGraphNode): void;
  onExecuted?(this: LGraphNode, output: NodeExecutionOutput): void;
  onConnectionsChange?(this: LGraphNode, ...args: Parameters<ConnectionsChangeCallback>): void;
  onRemoved?(this: LGraphNode): void;
  onAdded?(this: LGraphNode, graph: LGraph): void;
  onDrawBackground?(this: LGraphNode, ctx: CanvasRenderingContext2D, ...rest: unknown[]): void;
}

/** A registered node class, as passed to `beforeRegisterNodeDef`. */
export interface LGraphNodeConstructor {
  prototype: LGraphNode;
}

// ═══════════════════════════════════════════════════════════════════════════
// Node definitions + extensions
// ═══════════════════════════════════════════════════════════════════════════

/** Options part of a V1 input spec tuple. */
export interface InputSpecOptions {
  default?: unknown;
  socketless?: boolean;
  [key: string]: unknown;
}

/** V1 input spec tuple as passed to custom widget constructors. */
export type InputSpecV1 = readonly [unknown, InputSpecOptions?];

/** Node definition (subset). */
export interface ComfyNodeDef {
  name: string;
  [key: string]: unknown;
}

/** Custom widget constructor returned from `getCustomWidgets`. */
export type CustomWidgetConstructor = (
  node: LGraphNode,
  inputName: string,
  inputData: InputSpecV1,
  app: ComfyApp,
) => { widget?: IBaseWidget; minWidth?: number; minHeight?: number } | IBaseWidget | undefined;

/**
 * One settings-panel entry (subset of frontend `SettingParams`,
 * `src/platform/settings/types.ts`).
 */
export interface SettingParams {
  /** Unique id, prefixed `PainterSketch.`. */
  id: string;
  name: string;
  type: "boolean" | "number" | "slider" | "combo" | "text" | "hidden" | SettingCustomRenderer;
  defaultValue: unknown;
  /** Panel path; defaults to `id.split(".")`. */
  category?: string[];
  tooltip?: string;
  attrs?: Record<string, unknown>;
  options?: Array<string | { text: string; value?: string | number }>;
  sortOrder?: number;
  onChange?: (newValue: unknown, oldValue?: unknown) => void;
}

/** Custom renderer for a setting row (returns the element to mount). */
export type SettingCustomRenderer = (
  name: string,
  setter: (v: unknown) => void,
  value: unknown,
  attrs?: Record<string, unknown>,
) => HTMLElement;

/** Extension definition (subset of frontend `ComfyExtension`). */
export interface ComfyExtension {
  name: string;
  /** Settings-panel entries registered with the extension. */
  settings?: SettingParams[];
  getCustomWidgets?(app: ComfyApp): Record<string, CustomWidgetConstructor>;
  beforeRegisterNodeDef?(
    nodeType: LGraphNodeConstructor,
    nodeData: ComfyNodeDef,
    app: ComfyApp,
  ): void | Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// app + api singletons
// ═══════════════════════════════════════════════════════════════════════════

/** Toast message (subset of PrimeVue `ToastMessageOptions`). */
export interface ToastMessage {
  severity?: "success" | "info" | "warn" | "error";
  summary?: string;
  detail?: string;
  life?: number;
}

/** `app.extensionManager` (subset; every member optional at runtime). */
export interface ExtensionManager {
  toast?: { add?: (message: ToastMessage) => void };
  /** Settings store facade (`get` / `set` by setting id). */
  setting?: { get?: (id: string) => unknown };
  /** Command store facade (`execute` by command id). */
  command?: { execute?: (id: string) => Promise<void> | void };
  /**
   * Workflow store facade. The active workflow's `changeTracker` snapshots the
   * graph for undo and drives draft persistence (`graphChanged`).
   */
  workflow?: {
    activeWorkflow?: {
      changeTracker?: { captureCanvasState?: () => void; checkState?: () => void } | null;
    } | null;
  };
}

/** The ComfyUI `app` singleton (subset). */
export interface ComfyApp {
  registerExtension(extension: ComfyExtension): void;
  /** Set up during app init; guard every access. */
  extensionManager?: ExtensionManager;
  /** The root graph of the active workflow (unset before init). */
  readonly graph?: LGraph | null;
  /** Legacy UI facade; `settings.getSettingValue` is the older settings reader. */
  ui?: { settings?: { getSettingValue?: (id: string) => unknown } };
  /**
   * The `LGraphCanvas` (subset; both renderers). `graph` is the graph being
   * viewed (a subgraph while inside one). Set up during app init.
   */
  canvas?: { graph?: LGraph | null; setDirty?(foreground: boolean, background?: boolean): void } | null;
  /** Execution outputs keyed by NodeLocatorId (`"12"` or `"<subgraph-uuid>:12"`). */
  readonly nodeOutputs: Partial<Record<string, NodeExecutionOutput>>;
  /** Preview image URLs (often `blob:`) keyed by NodeLocatorId. */
  nodePreviewImages: Partial<Record<string, string[]>>;
  /** `&rand=...` cache-buster (empty on cloud). */
  getRandParam(): string;
}

/** The ComfyUI `api` singleton (subset). */
export interface ComfyApi {
  apiURL(route: string): string;
  /** `fetch` against the API base, adding auth headers. */
  fetchApi(route: string, options?: RequestInit): Promise<Response>;
  addEventListener(
    type: "executed",
    listener: (event: CustomEvent<ExecutedWsMessage>) => void,
  ): void;
  removeEventListener(
    type: "executed",
    listener: (event: CustomEvent<ExecutedWsMessage>) => void,
  ): void;
}
