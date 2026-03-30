/**
 * Supported event listener shapes accepted by the DOM event model.
 *
 * This matches the platform contract for `addEventListener()`: either a plain
 * function or an object implementing `handleEvent()`.
 */
export type EventListenerLike = EventListener | EventListenerObject;

/**
 * Internal listener bookkeeping record.
 *
 * The tuple of `listener + capture` is treated as the identity key, matching
 * the browser event target behavior used by `addEventListener()` and
 * `removeEventListener()`.
 */
export type ListenerRecord = {
  listener: EventListenerLike;
  capture: boolean;
  once: boolean;
  signal?: AbortSignal;
  abortCleanup?: () => void;
};

export const EVENT_PHASE_NONE = 0;
export const EVENT_PHASE_AT_TARGET = 2;

/**
 * Construction options for {@link EventDispatcher}.
 */
export interface EventDispatcherOptions<DispatchedErrorEvent extends Event = Event> {
  /**
   * Optionally creates an event to dispatch when a listener throws.
   *
   * If the returned event is canceled via `preventDefault()`, the
   * original exception is considered handled and is not forwarded to the global
   * error reporting channel.
   */
  createErrorEvent?: (
    error: unknown,
    causeEvent: Event,
  ) => DispatchedErrorEvent | null | undefined;

  /**
   * Optionally reports an unhandled listener error before the dispatcher falls
   * back to `globalThis.reportError()`.
   *
   * The second parameter is optional so `globalThis.reportError` can be passed
   * directly without adaptation.
   */
  reportError?: (error: unknown, causeEvent?: Event) => void;
}

/**
 * A small `EventTarget`-compatible dispatcher with strongly typed event maps.
 *
 * Differences from the native platform implementation:
 * - Only the at-target phase is modeled. There is no bubbling or capturing tree.
 * - Event names are string keys from `EventMap`.
 * - Listener exceptions are reported asynchronously instead of aborting the
 *   dispatch loop, mirroring browser event dispatch behavior.
 * - Optionally, listener exceptions can first dispatch a user-created event
 *   before they are reported globally.
 * - The implementation is intentionally self-contained and does not delegate to
 *   the host runtime's native `EventTarget` internals. This keeps behavior
 *   consistent across platforms whose built-in `EventTarget` details may differ.
 *
 * Type behavior:
 * - `EventMap` values must extend `Event`.
 * - Listener `this` is typed as the concrete dispatcher instance, so subclasses
 *   retain their own instance type in listeners.
 */
export class EventDispatcher<
  EventMap extends { [K in keyof EventMap]: Event } = Record<string, Event>,
> implements EventTarget {
  #listeners = new Map<string, ListenerRecord[]>();
  readonly #createErrorEvent?: EventDispatcherOptions<EventMap[keyof EventMap]>["createErrorEvent"];
  readonly #reportError?: EventDispatcherOptions<EventMap[keyof EventMap]>["reportError"];
  #isDispatchingFactoryErrorEvent = false;

  constructor(options: EventDispatcherOptions<EventMap[keyof EventMap]> = {}) {
    this.#createErrorEvent = options.createErrorEvent;
    this.#reportError = options.reportError;
  }

  /**
   * Register a typed listener for a known event name.
   *
   * Notes:
   * - Re-registering the same `listener` with the same `capture` flag is a no-op.
   * - `signal` follows the DOM contract: aborting it removes the listener.
   * - `once` removes the listener immediately before invocation.
   */
  addEventListener<K extends keyof EventMap & string>(
    type: K,
    listener: (this: this, ev: EventMap[K]) => any,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListener | EventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(type: unknown, listener: unknown, options?: unknown): void {
    if (typeof type !== "string" || !isEventListener(listener)) {
      return;
    }

    const normalized = normalizeAddEventListenerOptions(options);
    if (normalized.signal?.aborted) {
      return;
    }

    const listeners = this.#listeners.get(type) ?? [];
    // Native EventTarget uses `listener + capture` as the uniqueness key.
    const existing = listeners.find(
      (entry) => entry.listener === listener && entry.capture === normalized.capture,
    );
    if (existing) {
      return;
    }

    const record: ListenerRecord = {
      listener,
      capture: normalized.capture,
      once: normalized.once,
      signal: normalized.signal,
    };

    if (normalized.signal) {
      const onAbort = () => {
        this.removeEventListener(type, listener, { capture: normalized.capture });
      };

      normalized.signal.addEventListener("abort", onAbort, { once: true });
      record.abortCleanup = () => {
        normalized.signal?.removeEventListener("abort", onAbort);
      };
    }

    listeners.push(record);
    this.#listeners.set(type, listeners);
  }

  /**
   * Dispatch an event synchronously to all listeners registered for `event.type`.
   *
   * The implementation intentionally models the native `dispatchEvent()`
   * semantics for a single target:
   * - `event.target` becomes this dispatcher
   * - `event.currentTarget` is this dispatcher during listener invocation and `null`
   *   afterwards
   * - `event.eventPhase` is `AT_TARGET` during dispatch and `NONE` afterwards
   * - the return value is `!event.defaultPrevented`
   *
   * Because many event fields are read-only on platform event objects, dispatch
   * temporarily patches those fields and restores the original descriptors after
   * listener execution.
   */
  dispatchEvent(event: Event): boolean {
    if (!(event instanceof Event)) {
      throw new TypeError("Failed to execute 'dispatchEvent': parameter 1 is not of type 'Event'.");
    }

    const listeners = [...(this.#listeners.get(event.type) ?? [])];
    setReadonlyProperty(event, "target", this);

    if (!listeners.length) {
      setReadonlyProperty(event, "currentTarget", null);
      setReadonlyProperty(event, "eventPhase", EVENT_PHASE_NONE);
      return !event.defaultPrevented;
    }

    let immediatePropagationStopped = false;
    // Patch dispatch-only state to emulate the native DOM event view seen by
    // listeners while keeping the original descriptors restorable afterwards.
    const restoreDispatchState = patchDispatchState(event, {
      currentTarget: this,
      target: this,
      eventPhase: EVENT_PHASE_AT_TARGET,
      onStopImmediatePropagation() {
        immediatePropagationStopped = true;
      },
    });

    for (const record of listeners) {
      const currentListeners = this.#listeners.get(event.type);
      if (!currentListeners?.includes(record)) {
        continue;
      }

      if (record.once) {
        this.removeEventListener(event.type, record.listener, { capture: record.capture });
      }

      try {
        callEventListener(this, record.listener, event);
      } catch (error) {
        this.#handleListenerError(error, event);
      }

      if (immediatePropagationStopped) {
        break;
      }
    }

    restoreDispatchState();
    setReadonlyProperty(event, "target", this);
    setReadonlyProperty(event, "currentTarget", null);
    setReadonlyProperty(event, "eventPhase", EVENT_PHASE_NONE);

    return !event.defaultPrevented;
  }

  /**
   * Remove a previously registered listener.
   *
   * Like the DOM API, removal matches by `listener + capture`. Other option
   * fields such as `once` and `signal` do not participate in identity.
   */
  removeEventListener<K extends keyof EventMap & string>(
    type: K,
    listener: (this: this, ev: EventMap[K]) => any,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListener | EventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(type: unknown, listener: unknown, options?: unknown): void {
    if (typeof type !== "string" || !isEventListener(listener)) {
      return;
    }

    const normalized = normalizeRemoveEventListenerOptions(options);
    const listeners = this.#listeners.get(type);
    if (!listeners?.length) {
      return;
    }

    const index = listeners.findIndex(
      (entry) => entry.listener === listener && entry.capture === normalized.capture,
    );
    if (index === -1) {
      return;
    }

    const [removed] = listeners.splice(index, 1);
    removed?.abortCleanup?.();

    if (!listeners.length) {
      this.#listeners.delete(type);
    }
  }

  #handleListenerError(error: unknown, event: Event): void {
    if (!this.#createErrorEvent || this.#isDispatchingFactoryErrorEvent) {
      this.#reportListenerError(error, event);
      return;
    }

    const errorEvent = this.#createErrorEvent(error, event);
    if (!errorEvent) {
      this.#reportListenerError(error, event);
      return;
    }

    let handled = false;
    this.#isDispatchingFactoryErrorEvent = true;
    try {
      handled = !this.dispatchEvent(errorEvent);
    } finally {
      this.#isDispatchingFactoryErrorEvent = false;
    }

    if (!handled) {
      this.#reportListenerError(error, event);
    }
  }

  #reportListenerError(error: unknown, causeEvent: Event): void {
    reportListenerError(error, causeEvent, this.#reportError);
  }
}

/**
 * Runtime check for DOM-compatible listener values.
 */
function isEventListener(listener: unknown): listener is EventListenerLike {
  return (
    typeof listener === "function" ||
    (typeof listener === "object" &&
      listener !== null &&
      "handleEvent" in listener &&
      typeof (listener as EventListenerObject).handleEvent === "function")
  );
}

/**
 * Normalize the overloaded `addEventListener()` options shape into a single
 * internal record.
 */
function normalizeAddEventListenerOptions(options: unknown): {
  capture: boolean;
  once: boolean;
  signal?: AbortSignal;
} {
  if (typeof options === "boolean") {
    return {
      capture: options,
      once: false,
    };
  }

  if (options && typeof options === "object") {
    const normalized = options as AddEventListenerOptions;
    return {
      capture: !!normalized.capture,
      once: !!normalized.once,
      signal: normalized.signal,
    };
  }

  return {
    capture: false,
    once: false,
  };
}

/**
 * Normalize the subset of options relevant to listener removal.
 *
 * Only `capture` participates in removal matching.
 */
function normalizeRemoveEventListenerOptions(options: unknown): { capture: boolean } {
  if (typeof options === "boolean") {
    return { capture: options };
  }

  if (options && typeof options === "object") {
    return { capture: !!(options as EventListenerOptions).capture };
  }

  return { capture: false };
}

/**
 * Invoke either a function listener or an object listener with `handleEvent()`.
 */
function callEventListener(thisArg: EventTarget, listener: EventListenerLike, event: Event): void {
  if (typeof listener === "function") {
    listener.call(thisArg, event);
    return;
  }

  listener.handleEvent(event);
}

/**
 * Surface listener failures without aborting the current dispatch loop.
 *
 * The fallback chain is:
 * - a caller-provided `reportError(error, causeEvent)` function
 * - `globalThis.reportError(error)`
 * - rethrowing on a microtask
 */
function reportListenerError(
  error: unknown,
  causeEvent: Event,
  reportErrorOverride?: (error: unknown, causeEvent?: Event) => void,
): void {
  if (typeof reportErrorOverride === "function") {
    reportErrorOverride(error, causeEvent);
    return;
  }

  const reportError = (
    globalThis as typeof globalThis & {
      reportError?: (error: unknown) => void;
    }
  ).reportError;

  if (typeof reportError === "function") {
    reportError(error);
    return;
  }

  queueMicrotask(() => {
    throw error;
  });
}

/**
 * Patch the event fields that are observable only while dispatch is active.
 *
 * The returned function restores the original descriptors and methods so the
 * event object returns to its pre-dispatch state, except for the post-dispatch
 * values that are intentionally re-applied by `dispatchEvent()`.
 */
function patchDispatchState(
  event: Event,
  {
    currentTarget,
    target,
    eventPhase,
    onStopImmediatePropagation,
  }: {
    currentTarget: EventTarget | null;
    target: EventTarget | null;
    eventPhase: number;
    onStopImmediatePropagation: () => void;
  },
): () => void {
  const restoreCurrentTarget = overrideReadonlyProperty(event, "currentTarget", currentTarget);
  const restoreTarget = overrideReadonlyProperty(event, "target", target);
  const restoreEventPhase = overrideReadonlyProperty(event, "eventPhase", eventPhase);
  const restoreStopImmediatePropagation = overrideMethod(event, "stopImmediatePropagation", () => {
    onStopImmediatePropagation();
    Event.prototype.stopImmediatePropagation.call(event);
  });

  return () => {
    restoreStopImmediatePropagation();
    restoreEventPhase();
    restoreTarget();
    restoreCurrentTarget();
  };
}

/**
 * Define a configurable own data property, even if the platform property is
 * normally read-only.
 */
function setReadonlyProperty<TValue>(target: object, key: string, value: TValue): void {
  Object.defineProperty(target, key, {
    configurable: true,
    value,
  });
}

/**
 * Override a read-only property for the duration of dispatch and restore the
 * original own descriptor afterwards.
 */
function overrideReadonlyProperty<TValue>(target: object, key: string, value: TValue): () => void {
  const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
  setReadonlyProperty(target, key, value);

  return () => {
    if (ownDescriptor) {
      Object.defineProperty(target, key, ownDescriptor);
      return;
    }

    delete (target as Record<string, unknown>)[key];
  };
}

/**
 * Override an instance method temporarily and restore the previous descriptor
 * afterwards.
 *
 * This is used to intercept `stopImmediatePropagation()` so dispatch can stop
 * iterating local listeners while still delegating to the native event method.
 */
function overrideMethod<TTarget extends object, TKey extends keyof TTarget & string>(
  target: TTarget,
  key: TKey,
  method: TTarget[TKey],
): () => void {
  const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    value: method,
  });

  return () => {
    if (ownDescriptor) {
      Object.defineProperty(target, key, ownDescriptor);
      return;
    }

    delete (target as Record<string, unknown>)[key];
  };
}
