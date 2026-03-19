# evt

[English](./README.md)

提供跨平台一致行为的、类型化的 DOM 风格事件分发。

`evt` 提供了一个兼容 `EventTarget` 的小型事件分发器，适合需要以下能力的库：

- 类型化事件映射
- 可预测的监听器分发行为
- 不依赖不同运行时内部的 `EventTarget` 实现细节
- 可选的、可取消的 `"error"` 错误事件

## 安装

```bash
pnpm add @hornjs/evt
```

## 用法

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

## 类型化子类

listener 中的 `this` 会被推导为具体的分发器实例，因此继承后的子类仍然可以保留自己的实例类型。

```ts
class Bus extends EventDispatcher<{ ping: Event }> {
  label = "bus";
}

const bus = new Bus();

bus.addEventListener("ping", function () {
  console.log(this.label); // "bus"
});
```

## 错误事件

默认情况下，listener 抛出的异常会通过全局错误上报通道报告，但不会中断当前 dispatch 循环。

如果你希望 listener 抛错时先派发一个可取消的 `"error"` 事件，可以启用 `dispatchErrorEvent`。

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
  event.preventDefault(); // 标记该错误已被处理
});
```

如果 `"error"` 事件没有被取消，原始异常仍然会继续通过全局错误通道上报。

## 行为说明

- 事件名来自事件映射中的字符串 key。
- listener 的身份匹配规则和 DOM 一致：`listener + capture`。
- `once` 和 `signal` 的行为与 `addEventListener()` 保持一致。
- 当前只建模 at-target 阶段，不支持事件冒泡树。
- `event.target`、`event.currentTarget` 和 `event.eventPhase` 会被调整为符合 DOM 风格的 dispatch 语义。
- 实现内部使用自定义的 listener registry，而不是委托给宿主运行时的 `EventTarget`，以保证跨平台一致性。

## API

- `EventDispatcher<EventMap>`
- `EventDispatcherOptions`
- `EventDispatcherErrorEvent`
- `EVENT_PHASE_NONE`
- `EVENT_PHASE_AT_TARGET`
