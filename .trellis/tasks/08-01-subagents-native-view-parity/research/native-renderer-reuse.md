# Native renderer reuse: components, pairing, settings parity

## Reusable exported primitives (pi 0.83.0 package root; same in 0.82.1)

```ts
// dist/modes/interactive/components/*.d.ts (re-exported from package root)
UserMessageComponent(text, markdownTheme?, outputPad?)
AssistantMessageComponent(message?, hideThinkingBlock?, markdownTheme?, hiddenThinkingLabel?, outputPad?)
  - updateContent(message), setHiddenThinkingLabel(label), setExpanded?  (streaming pattern)
CustomMessageComponent(message, customRenderer?, markdownTheme?, outputPad?)
  - setExpanded(expanded)
ToolExecutionComponent(toolName, toolCallId, args, options, toolDefinition|undefined, ui, cwd)
  - options: { showImages?, imageWidthCells? }
  - updateArgs(args), markExecutionStarted(), setArgsComplete(), updateResult({content, isError, details?, ...}), setExpanded(expanded)
BashExecutionComponent(command, ui?, excludeFromContext?)
  - appendOutput(output), setComplete(exitCode, cancelled, truncated?, fullOutputPath?)
SkillInvocationMessageComponent(skillBlock, markdownTheme?)
DynamicBorder, Spacer, Text, Markdown (pi-tui)
```

Verified at
`2/8e5c2bd0b6c89cb13fbcae02df12f43f48c288f2815e38f36315d6f3f00de25f/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/`.

## What stays private (do not touch)

- `session.extensionRunner.getMessageRenderer/getEntryRenderer` — renderer
  lookup (runner-internal). 0.82.1 == 0.83.0 (diff confirms no API change).
- `session.getToolDefinition(name)` — effective tool definition (with
  tool-display overrides). Unavailable to extensions.
- `settingsManager` — not exposed on `ReadonlySessionManager`.
- `InteractiveMode.addMessageToChat/renderSessionItems` — private composition.

## Viewer assembler (port of renderSessionItems, section by section)

Source behavior (interactive-mode.js 0.83.0):

- `addMessageToChat` (2611-2687): bashExecution → BashExecutionComponent;
  custom → CustomMessageComponent(_message_, getMessageRenderer(customType), markdownTheme, outputPad); compactionSummary/branchSummary → their components; user → Spacer + (skillBlock ? SkillInvocationMessageComponent + UserMessageComponent : UserMessageComponent(textContent, markdownTheme, outputPad)); assistant → AssistantMessageComponent(message, hideThinkingBlock, markdownTheme, hiddenThinkingLabel, outputPad).
- `renderSessionItems` (2688-2760): for each item — assistant → addMessageToChat + extract `content[].toolCall` → ToolExecutionComponent(name, id, args, {showImages, imageWidthCells}, getRegisteredToolDefinition(name), ui, cwd) + setExpanded(toolOutputExpanded); aborted/error stopReason → updateResult(error, isError); else keep pending; toolResult → update matched pending component by toolCallId; user/custom/bash kept as-is.
- Live events (2320-2460): message_start(assistant) → streaming AssistantMessageComponent(undefined, ...) + updateContent; message_update → updateContent + create/update ToolExecutionComponent for toolCall blocks (pendingTools map); message_end → finalize component, error handling on aborted/error, setArgsComplete on pending tools; tool_execution_start → markExecutionStarted; tool_execution_update → updateArgs / partial result; tool_result_end → updateResult({...result, isError}).

The child-conversation assembler ports this 1:1 for the child while the
channel delivers the same event shapes. The assembler lives in
`src/tui/child-conversation/`, independent of transport:
- `assemble(records: SteerTranscriptRecord[] | rpc line events)` → item list
  (user/assistant/toolCall/toolResult/custom/bashExecution/fallback), pairing
  toolCall↔toolResult by toolCallId.
- History seeding: transcript records (`writeMessage` persists full Message
  objects with content incl. toolCall blocks, stopReason, errorMessage;
  `tool_result_end` persists full toolResult messages).
- Live: raw RPC lines from channel.onStdoutLine go through the same encoder.

## Settings parity (source of truth)

Pi merges `<agentDir>/settings.json` (global) with `<cwd>/.pi/settings.json`
(project) via deepMergeSettings — project wins (settings-manager.js:144).
Extension context has NO settings accessor. Plan: the viewer reads both JSON
files directly (like tool-display/zentui read their own configs) and extracts:

| View input | Settings key | Default |
| --- | --- | --- |
| hideThinkingBlock | `hideThinkingBlock` | false |
| outputPad | `outputPad` (0 → 0 else 1) | 1 |
| showImages | `terminal.showImages` | true |
| imageWidthCells | `terminal.imageWidthCells` | 60 (≥1) |
| markdown codeBlockIndent | `markdown.codeBlockIndent` | "  " |
| hiddenThinkingLabel | (no public getter) | "Thinking..." |

markdown theme = `getMarkdownTheme()` (exported) + codeBlockIndent, exactly the
main view's `getMarkdownThemeWithSettings()`.
toolOutputExpanded → `ctx.ui.getToolsExpanded()` (public in 0.83.0 and present
in this repo's pinned 0.82.1? — must verify; fallback: track the app default
collapsed). The viewer re-reads settings on open and on a small TTL (e.g. 500ms
cache) so `/settings` toggles apply; re-applies `setExpanded` per render pass.

hiddenThinkingLabel is settable only via `ctx.ui.setHiddenThinkingLabel`; the
current effective value is app-internal. Best effort: use the default and, if
the label was changed at runtime, reuse the last label this extension observed
for its own ctx (documented in README as best-effort).

## prototype patch inheritance (opportunistic)

- `pi-tool-display` patches `UserMessageComponent.prototype`
  (user-message-box-native.ts:1-58) → reused user components inherit it.
- `pi-zentui` patches `UserMessageComponent.prototype.render`/`invalidate` and
  wraps the predecessor (user-message.ts:211-248) → inherits load-order chain.
- Both apply because the runtime extension and the viewer share the same
  module realm. Not an API; covered by a compatibility smoke test, not promised.

## Generic fallback policy

ToolExecutionComponent accepts `toolDefinition === undefined` → generic
name/args/result rendering; that IS the honest generic path (main view passes a
definition when registered; undefined renders generic). Unknown customType →
explicit `Markdown`/`Text` fallback labeled "(generic fallback)". Malformed or
`truncated` transcript records → bounded Markdown/Text fallback as today.

## Out of scope (per PRD)

- Private renderer registry / tool definition enumeration; InteractiveMode
  private imports; switchSession; SessionManager.open on child files; exact
  tool-display-per-tool ownership reproduction (definitions are private;
  generic components inherit only the prototype patches).