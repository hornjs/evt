import * as evt from "./index.js";
import { describe, expect, test, vi } from "vitest";

import {
  EVENT_PHASE_AT_TARGET,
  EVENT_PHASE_NONE,
  EventDispatcher,
} from "./index.js";

class ServerErrorEvent extends Event {
  readonly error: unknown;
  readonly causeEvent: Event;

  constructor(error: unknown, causeEvent: Event) {
    super("server-error", { cancelable: true });
    this.error = error;
    this.causeEvent = causeEvent;
  }
}

class ListenerErrorEvent extends Event {
  readonly error: unknown;
  readonly causeEvent: Event;

  constructor(error: unknown, causeEvent: Event) {
    super("error", { cancelable: true });
    this.error = error;
    this.causeEvent = causeEvent;
  }
}

type PingEventMap = {
  ping: Event;
  error: ListenerErrorEvent;
  "server-error": ServerErrorEvent;
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
  test("does not export a built-in error event class", () => {
    expect("EventDispatcherErrorEvent" in evt).toBe(false);
  });

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

  test("dispatches a factory-created error event when a listener throws", () => {
    const dispatcher = new EventDispatcher<PingEventMap>({
      createErrorEvent(error, causeEvent) {
        return new ListenerErrorEvent(error, causeEvent);
      },
    });
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

  test("reports thrown errors when createErrorEvent is not configured", () => {
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

  test("dispatches a custom event returned by createErrorEvent", () => {
    const dispatcher = new EventDispatcher<PingEventMap>({
      createErrorEvent(error, causeEvent) {
        return new ServerErrorEvent(error, causeEvent);
      },
    });
    const reportedError = stubReportError();
    const original = new Error("boom");
    let receivedEvent: ServerErrorEvent | undefined;

    dispatcher.addEventListener("server-error", (event) => {
      receivedEvent = event;
      event.preventDefault();
    });
    dispatcher.addEventListener("ping", () => {
      throw original;
    });

    dispatcher.dispatchEvent(new Event("ping"));

    expect(receivedEvent).toBeInstanceOf(ServerErrorEvent);
    expect(receivedEvent?.error).toBe(original);
    expect(receivedEvent?.causeEvent.type).toBe("ping");
    expect(reportedError.spy).not.toHaveBeenCalled();
    reportedError.restore();
  });

  test("reports the original error when createErrorEvent returns null", () => {
    const dispatcher = new EventDispatcher<PingEventMap>({
      createErrorEvent() {
        return null;
      },
    });
    const reportedError = stubReportError();
    const original = new Error("boom");

    dispatcher.addEventListener("ping", () => {
      throw original;
    });

    dispatcher.dispatchEvent(new Event("ping"));

    expect(reportedError.spy).toHaveBeenCalledWith(original);
    reportedError.restore();
  });

  test("reports the original error when a custom error event is not canceled", () => {
    const dispatcher = new EventDispatcher<PingEventMap>({
      createErrorEvent(error, causeEvent) {
        return new ServerErrorEvent(error, causeEvent);
      },
    });
    const reportedError = stubReportError();
    const original = new Error("boom");
    let receivedEvent: ServerErrorEvent | undefined;

    dispatcher.addEventListener("server-error", (event) => {
      receivedEvent = event;
    });
    dispatcher.addEventListener("ping", () => {
      throw original;
    });

    dispatcher.dispatchEvent(new Event("ping"));

    expect(receivedEvent).toBeInstanceOf(ServerErrorEvent);
    expect(reportedError.spy).toHaveBeenCalledWith(original);
    reportedError.restore();
  });

  test("does not recursively create new events for errors thrown by factory-produced events", () => {
    const createErrorEvent = vi.fn((error: unknown, causeEvent: Event) => {
      return new ServerErrorEvent(error, causeEvent);
    });
    const dispatcher = new EventDispatcher<PingEventMap>({ createErrorEvent });
    const reportedError = stubReportError();
    const original = new Error("boom");
    const nested = new Error("nested");

    dispatcher.addEventListener("server-error", () => {
      throw nested;
    });
    dispatcher.addEventListener("ping", () => {
      throw original;
    });

    dispatcher.dispatchEvent(new Event("ping"));

    expect(createErrorEvent).toHaveBeenCalledTimes(1);
    expect(reportedError.spy).toHaveBeenCalledWith(nested);
    expect(reportedError.spy).toHaveBeenCalledWith(original);
    expect(reportedError.spy).toHaveBeenCalledTimes(2);
    reportedError.restore();
  });
});
