# evt

[简体中文](./README.zh-CN.md)

Typed `EventTarget`-compatible event dispatching with cross-platform-consistent behavior.

`evt` provides a small `EventTarget`-compatible dispatcher for libraries that
want:

- typed event maps
- predictable listener dispatch behavior
- no dependence on runtime-specific `EventTarget` internals
- an optional cancelable `"error"` event for listener failures

## Installation

```bash
pnpm add @hornjs/evt
```

## Usage

```ts
import { EventDispatcher } from "@hornjs/evt";

type Events = {
  ping: Event;
  message: CustomEvent<{ text: string }>;
};

const dispatcher = new EventDispatcher<Events>();

dispatcher.addEventListener("message", function (event) {
  console.log(event.detail.text);
  console.log(this === dispatcher); // true
});

dispatcher.dispatchEvent(
  new CustomEvent("message", {
    detail: { text: "hello" },
  }),
);
```

## Typed Subclasses

Listener `this` is typed as the concrete dispatcher instance, so subclasses keep
their own instance type.

```ts
class Bus extends EventDispatcher<{ ping: Event }> {
  label = "bus";
}

const bus = new Bus();

bus.addEventListener("ping", function () {
  console.log(this.label); // "bus"
});
```

## Error Events

By default, listener exceptions are reported through the global error reporting
channel and do not abort the current dispatch loop.

If you want thrown listener errors to first dispatch a custom event, provide
`createErrorEvent`.

```ts
import { EventDispatcher } from "@hornjs/evt";

class ListenerErrorEvent extends Event {
  constructor(
    readonly error: unknown,
    readonly causeEvent: Event,
  ) {
    super("error", { cancelable: true });
  }
}

type Events = {
  ping: Event;
  error: ListenerErrorEvent;
};

const dispatcher = new EventDispatcher<Events>({
  createErrorEvent(error, causeEvent) {
    return new ListenerErrorEvent(error, causeEvent);
  },
});

dispatcher.addEventListener("error", (event) => {
  console.error(event.error);
  console.log(event.causeEvent.type); // "ping"
  event.preventDefault(); // marks the error as handled
});
```

You can also return your own event type:

```ts
class ServerErrorEvent extends Event {
  constructor(
    readonly error: unknown,
    readonly causeEvent: Event,
  ) {
    super("server-error", { cancelable: true });
  }
}

type Events = {
  ping: Event;
  "server-error": ServerErrorEvent;
};

const dispatcher = new EventDispatcher<Events>({
  createErrorEvent(error, causeEvent) {
    return new ServerErrorEvent(error, causeEvent);
  },
});
```

If the returned event is not canceled, the original exception is still reported
globally. If you want `preventDefault()` to mark the error as handled, make sure
the returned event is cancelable.

You can also override how unhandled listener errors are reported:

```ts
const dispatcher = new EventDispatcher<Events>({
  reportError(error, causeEvent) {
    console.error("listener failure", error, causeEvent?.type);
  },
});
```

The second parameter is optional, so `globalThis.reportError` remains directly
assignable.

## Behavior Notes

- Event names are string keys from the event map.
- Listener identity matches the DOM model: `listener + capture`.
- `once` and `signal` behave like `addEventListener()`.
- Dispatch is limited to a single target; it does not model DOM capture or bubbling propagation.
- `event.target`, `event.currentTarget`, and `event.eventPhase` are patched to
  follow DOM-style dispatch semantics.
- The implementation uses its own listener registry instead of delegating to the
  host runtime's `EventTarget`, so behavior stays consistent across platforms.

## API

- `EventDispatcher<EventMap>`
- `EventDispatcherOptions`
- `EVENT_PHASE_NONE`
- `EVENT_PHASE_AT_TARGET`
