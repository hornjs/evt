import { describe, expect, test, vi } from "vitest";

import {
  EVENT_PHASE_AT_TARGET,
  EVENT_PHASE_NONE,
  EventDispatcher,
  EventDispatcherErrorEvent,
} from "./index.js";

type PingEventMap = {
  ping: Event;
  error: EventDispatcherErrorEvent;
};

function stubReportError() {
  const original = (
    globalThis as typeof globalThis & {
      reportError?: (error: unknown) => void;
    }
  ).reportError;
  const spy = vi.fn();
  Object.assign(globalThis, { reportError: spy });

  return {
    spy,
    restore() {
      if (original) {
        Object.assign(globalThis, { reportError: original });
      } else {
        Reflect.deleteProperty(globalThis, "reportError");
      }
    },
  };
}

describe("EventDispatcher", () => {
  test("is EventTarget-compatible without inheriting the host EventTarget implementation", () => {
    const dispatcher = new EventDispatcher<PingEventMap>();

    expect(dispatcher).not.toBeInstanceOf(EventTarget);
  });

  test("binds listener this to the concrete dispatcher instance", () => {
    class CustomDispatcher extends EventDispatcher<PingEventMap> {
      readonly label = "custom";
    }

    const dispatcher = new CustomDispatcher();
    let sawExpectedThis = false;

    dispatcher.addEventListener("ping", function () {
      expect(this).toBe(dispatcher);
      expect(this.label).toBe("custom");
      sawExpectedThis = true;
    });

    dispatcher.dispatchEvent(new Event("ping"));

    expect(sawExpectedThis).toBe(true);
  });

  test("exposes target, currentTarget and eventPhase like a DOM dispatcher", () => {
    const dispatcher = new EventDispatcher<PingEventMap>();
    const event = new Event("ping");
    let targetDuringDispatch: EventTarget | null = null;
    let currentTargetDuringDispatch: EventTarget | null = null;
    let phaseDuringDispatch = EVENT_PHASE_NONE;

    dispatcher.addEventListener("ping", (receivedEvent) => {
      targetDuringDispatch = receivedEvent.target;
      currentTargetDuringDispatch = receivedEvent.currentTarget;
      phaseDuringDispatch = receivedEvent.eventPhase;
    });

    const dispatched = dispatcher.dispatchEvent(event);

    expect(dispatched).toBe(true);
    expect(targetDuringDispatch).toBe(dispatcher);
    expect(currentTargetDuringDispatch).toBe(dispatcher);
    expect(phaseDuringDispatch).toBe(EVENT_PHASE_AT_TARGET);
    expect(event.target).toBe(dispatcher);
    expect(event.currentTarget).toBeNull();
    expect(event.eventPhase).toBe(EVENT_PHASE_NONE);
  });

  test("deduplicates by listener and capture and honors once removal", () => {
    const dispatcher = new EventDispatcher<PingEventMap>();
    const listener = vi.fn();

    dispatcher.addEventListener("ping", listener, { once: true });
    dispatcher.addEventListener("ping", listener, { once: true });
    dispatcher.dispatchEvent(new Event("ping"));
    dispatcher.dispatchEvent(new Event("ping"));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("dispatches a cancelable error event when enabled", () => {
    const dispatcher = new EventDispatcher<PingEventMap>({ dispatchErrorEvent: true });
    const reportedError = stubReportError();
    const original = new Error("boom");
    let receivedError: unknown;
    let receivedCause: Event | undefined;

    dispatcher.addEventListener("error", (event) => {
      receivedError = event.error;
      receivedCause = event.causeEvent;
      event.preventDefault();
    });
    dispatcher.addEventListener("ping", () => {
      throw original;
    });

    dispatcher.dispatchEvent(new Event("ping"));

    expect(receivedError).toBe(original);
    expect(receivedCause?.type).toBe("ping");
    expect(reportedError.spy).not.toHaveBeenCalled();
    reportedError.restore();
  });

  test("reports thrown errors when auto error events are disabled", () => {
    const dispatcher = new EventDispatcher<PingEventMap>();
    const reportedError = stubReportError();
    const original = new Error("boom");

    dispatcher.addEventListener("ping", () => {
      throw original;
    });

    dispatcher.dispatchEvent(new Event("ping"));

    expect(reportedError.spy).toHaveBeenCalledWith(original);
    reportedError.restore();
  });

  test("does not recursively dispatch error events from error listeners", () => {
    const dispatcher = new EventDispatcher<PingEventMap>({ dispatchErrorEvent: true });
    const reportedError = stubReportError();
    const original = new Error("boom");
    const nested = new Error("nested");

    dispatcher.addEventListener("error", () => {
      throw nested;
    });
    dispatcher.addEventListener("ping", () => {
      throw original;
    });

    dispatcher.dispatchEvent(new Event("ping"));

    expect(reportedError.spy).toHaveBeenCalledWith(nested);
    expect(reportedError.spy).toHaveBeenCalledWith(original);
    expect(reportedError.spy).toHaveBeenCalledTimes(2);
    reportedError.restore();
  });
});
