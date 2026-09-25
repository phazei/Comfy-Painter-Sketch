/**
 * Minimal typed event emitter.
 */

/** Listener map: event name -> payload type. */
export type EventMap = Record<string, unknown>;

/**
 * Typed emitter; `on` returns an unsubscribe function.
 */
export class Emitter<E extends EventMap> {
  private readonly listeners = new Map<keyof E, Set<(payload: never) => void>>();

  /**
   * Subscribe.
   * @param event - Event name.
   * @param listener - Callback.
   * @returns Unsubscribe function.
   */
  on<K extends keyof E>(event: K, listener: (payload: E[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => set.delete(listener as (payload: never) => void);
  }

  /**
   * Notify listeners.
   * @param event - Event name.
   * @param payload - Payload.
   */
  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) (listener as (p: E[K]) => void)(payload);
  }

  /** Remove all listeners. */
  clear(): void {
    this.listeners.clear();
  }
}
