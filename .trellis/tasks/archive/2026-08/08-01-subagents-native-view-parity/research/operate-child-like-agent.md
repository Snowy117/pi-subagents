# Operating the child like the main agent: shortcuts, models, thinking, plugins

Research for R1/R2 extension — can a selected child be operated the way the
main agent is operated (esc abort, model/thinking change, TUI plugins)?

## 1. The child RPC protocol already supports every "operate" command

`dist/modes/rpc/rpc-types.d.ts` (0.83.0) defines client→server commands; the
child resolves them in `rpc-mode.js`:

| Action | Command | Child behavior (rpc-mode.js) | Response |
| --- | --- | --- | --- |
| Abort current stream | `abort` | `session.abort()` (:328) | `{id, type:"response", command:"abort", success}` |
| Cycle model fwd | `cycle_model` | `session.cycleModel()` (:372) | `{... success, data: model}` |
| Set model | `set_model {provider, modelId}` | `session.setModel(model)` (:376) | success / error "Model not found" |
| List models | `get_available_models` | `session.modelRuntime.getAvailable()` (:382) | `{... data: {models}}` |
| Cycle thinking | `cycle_thinking_level` | `session.cycleThinkingLevel()` (:390) | `{... data: {level}}` |
| Set thinking | `set_thinking_level {level}` | `session.setThinkingLevel(level)` (:386) | success |
| List thinking levels | `get_available_thinking_levels` | `session.getAvailableThinkingLevels()` (:393) | `{... data: {levels}}` |
| Live state | `get_state` | model/thinkingLevel/isStreaming/… (:344) | `{... data: state}` |

All of these travel over the same `ChildConversationChannel` (LocalRpcChannel
stdin or the async bridge request inbox). The runner's `RpcWrite` is generic
(`write(command)`), so the viewer does not need a new protocol — just new
outbound record types on the channel.

## 2. Main-view keybindings and who owns a keypress in child mode

`dist/core/keybindings.js` (0.83.0):

| app action | default keys | child-mode equivalent |
| --- | --- | --- |
| app.interrupt | escape | child RPC `abort` (only while child streaming) |
| app.thinking.cycle | shift+tab | child RPC `cycle_thinking_level` |
| app.model.cycleForward | ctrl+p | child RPC `cycle_model` |
| app.model.cycleBackward | shift+ctrl+p | `get_available_models` + `set_model(prev)` |
| app.model.select | ctrl+l | `get_available_models` → viewer `ctx.ui.select()` → `set_model` |
| app.tools.expand | ctrl+o | toggle the child view's own expand state (assembler) |
| app.thinking.toggle | ctrl+t | toggle the child view's own hideThinkingBlock |
| app.clear | ctrl+c | NOT intercepted (editor-owned) |
| app.exit | ctrl+d | NOT intercepted |

Key ownership in host-editor mode:
- The real Pi editor keeps focus, so **all editor-level keys stay editor-owned**
  (typing, history, multiline, paste, IME, autocomplete, line editing) — that
  part is already "like the main agent".
- **App-level keybindings are registered on the parent InteractiveMode**
  (`defaultEditor.onAction("app.*", ...)`); without interception they act on
  the PARENT (e.g. ctrl+p would cycle the parent model while the user believes
  they are operating the child).
- `ctx.ui.onTerminalInput(handler)` returns `{ consume: true }` and runs
  BEFORE the focused editor (TUI inputListeners precede focused-component
  dispatch). The extension already uses this for the Down shortcut
  (entry-shortcut.ts) — so a child-mode keybinding interceptor is a proven
  pattern, active only while child mode is active.
- Interception must be scoped: only the app-level keys listed above, and only
  when child mode is active. Esc is intercepted only while the child is
  streaming (busy = prompt-sent until agent_settled; can cross-check with
  get_state), otherwise Esc falls through to close autocomplete exactly as the
  main view does.
- The model selector (ctrl+l) is rendered viewer-side via `ctx.ui.select()`;
  a perfect `ModelSelectorComponent` is a TUI direct component not available
  over RPC (documented boundary; functional equivalence only).

## 3. TUI plugin behavior in the child view

| Plugin (installed) | What it does | Child-view effect |
| --- | --- | --- |
| pi-tool-display@0.5.0 | patches `UserMessageComponent.prototype` (user-message-box-native.ts:1-58); replaces runtime tool definitions (read/ls/edit/write) with renderCall/renderResult via `pi.registerTool` | user-message box style **inherited** (same module realm prototype patch); per-tool renderers NOT available to the viewer (`getAllTools()` returns `ToolInfo` = Pick<ToolDefinition, name\|description\|parameters\|promptGuidelines> only — renderCall/renderResult are stripped, types.d.ts:1122-1125) → tools stay generic unless later upstream exposes definitions |
| pi-zentui@0.15.0 | custom editor compositor + `UserMessageComponent.prototype.render/invalidate` patch chain (user-message.ts:211-248) | editor appearance applies (host editor untouched by child mode); user-component patch chain inherited |
| pi-open-tui@0.2.10 | header/footer/editor only (`setHeader`, `setFooter`, `setEditorComponent(OpenTuiEditor)`) — no message-component patches | header/footer/editor visuals apply to the host layout; our widget renders inside the existing layout above the editor; OpenTuiEditor stays the focused editor (typing parity) |
| editor-key wrappers (any setEditorComponent) | replace editor | host editor retained → its behavior applies in child mode (input parity) |

Summary for plugins: **prototype-patch chains on reused native components
inherit; setHeader/setFooter/setEditorComponent hosts keep applying; private
renderer registries (tool renderers, custom message renderer lookup) do not
flow**. Honest boundary: user messages/layout/editor = inherited; tool cards and
unknown custom types = explicit generic fallback.

## 4. Feasibility verdict

- E sc abort, model cycle/select, thinking cycle/select, compact, steering
  mode, follow-up mode: all available as child RPC commands; all forwardable
  through LocalRpcChannel and the async bridge identically (a pure addition to
  the channel's outbound record set).
- Keybinding routing while child mode is active: interception is technically
  straightforward (onTerminalInput + consume) and scoped (active-flag gated);
  default-to-parent for non-intercepted keys is the documented behavior.
- Gaps that cannot be closed without private APIs (document, do not fake):
  tool-display per-tool renderers in the child view; a byte-identical model
  selector; `//` autocomplete suggestions (parent's provider).