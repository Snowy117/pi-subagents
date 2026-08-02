# Fix subagent crash: ToolExecutionComponent ui.requestRender, tool rendering, working indicator

## Goal

修复子代理对话中三个相互关联的问题：

1. **Crash**: `TypeError: this.ui.requestRender is not a function` at `ToolExecutionComponent.setArgsComplete` — assembler 把 `ctx.ui`（ExtensionUIContext，无 `requestRender`）当作 TUI 传给组件。
2. **Working indicator 一直转**: 主 agent 认为工具调用未完成，'Working...' 动画持续显示在编辑器上方。
3. **工具条渲染**: 主 agent 只渲染 'subagent parallel (1)' 而不是工具条 + 加载动画（旧版本行为）。

## Background / Confirmed Facts

### Crash 根因（已确认）

- `ToolExecutionComponent` 构造函数接收 `ui` 参数并调用 `this.ui.requestRender()`（4 处：`updateDisplay`/`markExecutionStarted`/`setArgsComplete`/`getRenderContext`）。
- `src/tui/steer-view/host-editor-mode.ts:270` 把 `ctx.ui as unknown as TUI` 传给 assembler 的 `ui` 选项。
- `ctx.ui` 是 `ExtensionUIContext`（`dist/core/extensions/types.d.ts`）——**没有 `requestRender` 成员**（已在之前任务确认）。
- 所以 `ToolExecutionComponent.setArgsComplete()` → `this.ui.requestRender()` → TypeError。
- 修复方向：assembler 的 `ui` 必须是**真 TUI**（widget 工厂收到的 `tui`），或提供 lazy-delegating 适配器（有 `requestRender` 时调用，否则 no-op）。

### Working indicator / 工具条（部分确认，需继续调查）

- 主 agent 的工具条渲染由 `ToolExecutionComponent.renderCall` 处理（`tools.ts:renderCall` → `'subagent parallel (1)'` 文本）。
- Working indicator 由主 agent 的 `setWorkingMessage/setWorkingVisible` 控制（`ctx.ui` 有这些方法）。
- 当工具调用长时间不结束，working 持续显示。可能因为初始 prompt 未送达 → 子代理闲置 → 工具调用未完成 → working 一直转 + gateway 无请求。
- `rpcWrite.write({type:"prompt", message: task ?? ""})` 在 spawn 后立即写，无 drain/ready 等待。RPC 模式可能需要 stdin ready 事件。

### 相关代码

- `src/tui/child-conversation/assemble-message.ts:37` — `new ToolExecutionComponent(..., state.ui, state.cwd)`
- `src/tui/child-conversation/assembly-types.ts` — `AssemblerState.ui: TUI`
- `src/tui/steer-view/host-editor-mode.ts:270` — `ui: ctx.ui as unknown as TUI`
- `src/runs/persistent/rpc-protocol.ts` — `write()` 写入 stdin
- `src/runs/background/runner/run-pi-streaming.ts:359` — `rpcWrite.write({type:"prompt", message: task ?? ""})`

## Requirements

### R1 修复 crash：组件收到真 TUI

- assembler 的 `ui` 改为接收**真 TUI**（widget 工厂的 `tui`）或 lazy-delegating adapter。
- 保证 `ToolExecutionComponent` / `BashExecutionComponent` 的 `this.ui.requestRender()` 可用。
- 从 `host-editor-mode.ts` 的 `ctx.ui as unknown as TUI` 改为从 widget 工厂传真 tui。

### R2 修复 working indicator

- 调查主 agent 工具调用 completion 事件（`tool_result_end`? `agent_settled`?）如何触发 `setWorkingVisible(false)`。
- 确保子代理的工具调用正确完成，主 agent 的 working 动画停止。

### R3 工具条渲染

- 恢复主 agent 工具条 + 加载动画（旧版本行为）。
- 工具调用渲染走原生 `ToolExecutionComponent`（renderCall）。

### R4 初始 prompt 送达

- 验证 async/foreground 的初始 prompt 是否确实送达（`rpcWrite.write` 时序）。
- 若无 drain/ready 处理导致 prompt 丢失，修复。

## Acceptance Criteria

- [ ] AC-1 无 crash：子代理对话中 `ToolExecutionComponent.setArgsComplete` 不再抛 TypeError。
- [ ] AC-2 working 停止：主 agent 工具调用完成后 working 动画消失。
- [ ] AC-3 工具条：主 agent 显示工具条 + 加载动画（与旧版本一致）。
- [ ] AC-4 初始 prompt 送达：子代理无需用户干预即开始工作（gateway 有请求）。
- [ ] AC-5 回归：`npm run test:unit` 全绿。

## Out of Scope

- 重构子代理的整个生命周期。
- 修改 pi 上游组件。

## Open Questions

- Q1: working indicator 持续显示的准确触发链（主 agent 工具调用如何结束）。
- Q2: 初始 prompt 是否真的丢失（还是只是 idle 状态）。
