# evt

[简体中文](./README.zh-CN.md)

Typed DOM-style event dispatching with cross-platform-consistent behavior.

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

If you want thrown listener errors to first dispatch a cancelable `"error"`
event, enable `dispatchErrorEvent`.

```ts
import { EventDispatcher, EventDispatcherErrorEvent } from "@hornjs/evt";

type Events = {
  ping: Event;
  error: EventDispatcherErrorEvent;
};

const dispatcher = new EventDispatcher<Events>({
  dispatchErrorEvent: true,
});

dispatcher.addEventListener("error", (event) => {
  console.error(event.error);
  console.log(event.causeEvent.type); // "ping"
  event.preventDefault(); // marks the error as handled
});
```

If an `"error"` event is not canceled, the original exception is still reported
globally.

## Behavior Notes

- Event names are string keys from the event map.
- Listener identity matches the DOM model: `listener + capture`.
- `once` and `signal` behave like `addEventListener()`.
- Dispatch models the at-target phase only. There is no bubbling tree.
- `event.target`, `event.currentTarget`, and `event.eventPhase` are patched to
  follow DOM-style dispatch semantics.
- The implementation uses its own listener registry instead of delegating to the
  host runtime's `EventTarget`, so behavior stays consistent across platforms.

## API

- `EventDispatcher<EventMap>`
- `EventDispatcherOptions`
- `EventDispatcherErrorEvent`
- `EVENT_PHASE_NONE`
- `EVENT_PHASE_AT_TARGET`
