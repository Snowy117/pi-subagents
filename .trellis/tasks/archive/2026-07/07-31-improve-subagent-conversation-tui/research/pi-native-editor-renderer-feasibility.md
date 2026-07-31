# Pi 0.82.1 native editor and renderer feasibility

## Scope and answer

This report answers whether the interactive subagent conversation view can reuse
Pi 0.82.1's **actual active editor** and **effective message/tool rendering
pipeline**, including changes made by installed extensions. It is planning
research only; no product implementation is included.

The short answer is:

1. **The active Pi editor cannot be embedded in `ctx.ui.custom()` through a
   supported API.** Pi exposes editor text handoff and a global editor
   replacement factory, but it does not expose the live editor instance or a
   host-wired editor-cloning service.
2. **The complete effective transcript renderer cannot be reused through a
   supported API.** Pi exports useful native message/tool component classes,
   but renderer lookup, registered tool definitions, settings-aware transcript
   assembly, and tool-call/result pairing remain inside `InteractiveMode` and
   the active session runtime.
3. **A supported hybrid is viable.** Keep the parent-preserving full-screen
   overlay and child control channel, keep a local child composer, hand leading
   slash input back to the real parent editor, and progressively use exported
   native visual components where their complete inputs are available. Tool and
   custom-message rendering must retain an explicit generic fallback.
4. **Installed prototype patches can affect reused native components, but this
   is incidental rather than a renderer API.** On this host, both
   `pi-tool-display` and `pi-zentui` patch `UserMessageComponent.prototype`.
   Conversely, `pi-tool-display`'s effective tool renderers are stored on tool
   definitions that the viewer cannot retrieve publicly.

Therefore the recommended MVP is the supported hybrid in section
“Recommended MVP.” Full native editor and renderer parity should be tracked as
an upstream Pi API gap, not implemented with private imports or session
attachment.

## Evidence baseline

### Pi version and supported import surface

- The repository resolves `@earendil-works/pi-coding-agent` version `0.82.1`.
- The package export map exposes the package root and `./rpc-entry`; consumers
  should import the native components from the package root rather than from
  `dist/modes/interactive/**` private paths.
- Root declarations export `InteractiveMode`, `CustomEditor`,
  `AssistantMessageComponent`, `UserMessageComponent`,
  `CustomMessageComponent`, and `ToolExecutionComponent` from
  `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts`.

An exported class is a reusable visual primitive. It is not, by itself, a
public service that reproduces how the live `InteractiveMode` selects,
configures, and composes that class.

### Extension discovery on this host

The effective user package list is in `/home/neko/.pi/agent/settings.json:3`.
It includes, in order, `npm:pi-tool-display` and `npm:pi-zentui` at
`/home/neko/.pi/agent/settings.json:6-7`.

Pi's documented package contract says that user npm installs live below
`~/.pi/agent/npm/` and that a package's `pi.extensions` manifest identifies its
extension entry points
(`node_modules/@earendil-works/pi-coding-agent/docs/packages.md:39-74` and
`:122-169`). Pi also auto-discovers global extension files from
`agentDir/extensions/`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:537-556`).

The relevant installed resources are:

- `/home/neko/.pi/agent/npm/node_modules/pi-tool-display`, version `0.5.0`,
  whose manifest entry is `./index.ts`
  (`/home/neko/.pi/agent/npm/node_modules/pi-tool-display/package.json:2-21,51-55`).
- `/home/neko/.pi/agent/npm/node_modules/pi-zentui`, version `0.15.0`, whose
  manifest entry is `./extensions`
  (`/home/neko/.pi/agent/npm/node_modules/pi-zentui/package.json:2-4,38-44`).
- `/home/neko/.pi/agent/extensions/pi-tool-display/config.json`, which is data
  read by the package, not a second TypeScript/JavaScript extension entry.
- `/home/neko/.pi/agent/zentui.json`, the active Zentui configuration.

`pi-tool-display@0.5.0` declares Pi peer ranges only through `^0.80.0`, whereas
`pi-zentui@0.15.0` declares `>=0.80.3`. Tool-display currently works by runtime
duck typing and mutation, but its undeclared 0.82 compatibility is a residual
risk (`/home/neko/.pi/agent/npm/node_modules/pi-tool-display/package.json:66-74`).

## Existing steer view: what is and is not native

The current viewer is deliberately independent of the parent session runtime:

- `SteerViewComponent` is an extension-owned `Component & Focusable` and owns a
  plain `Input` instance
  (`src/tui/steer-view/steer-view-component.ts:35-36`).
- Assistant text is rendered with a directly-created pi-tui `Markdown`, while
  user, fallback, and tool records use `Text` and manual labels
  (`src/tui/steer-view/steer-view-component.ts:18-31`).
- Tool rows are reduced to strings such as `▶ tool args` and `✓ tool`
  (`src/tui/steer-view/steer-view-component.ts:20-21`).
- Input handling, scroll behavior, focus switching, and submission are local to
  the component (`src/tui/steer-view/steer-view-component.ts:135-189`).
- The full conversation surface is a capturing overlay, not a session switch or
  host editor replacement (`src/tui/steer-view/open-view.ts:50-61`).
- A leading slash closes the overlay; only after the custom UI promise resolves
  does the controller call `ctx.ui.setEditorText()`
  (`src/tui/steer-view/open-view.ts:68-77`).

The transcript adapter also loses information needed by Pi's native renderer:

- `SteerTranscriptRecord` retains only simplified `message`, `tool_start`,
  `tool_end`, `truncated`, and `fallback` records
  (`src/tui/steer-view/transcript-tail.ts:7-14`).
- Message parsing retains `role` and optional text, not the complete Pi message
  content union, stop reason, thinking blocks, images, tool calls, or custom
  message metadata (`src/tui/steer-view/transcript-tail.ts:51-70`).
- Tool records retain a tool name and preview, not the complete call arguments,
  tool-call ID, `ToolResultMessage`, details, partial status, or image content
  (`src/tui/steer-view/transcript-tail.ts:68-73`).

The current tests intentionally codify this boundary: local focus/input and
Markdown scrolling are covered in
`test/unit/steer-view-component.test.ts:100-128`, slash handoff ordering in
`test/integration/steer-view-entry.test.ts:25-57`, and non-replacement of the
host `CustomEditor` in `test/integration/steer-view-entry.test.ts:98-105`.

## Public, private, and unavailable boundary

| Capability | Classification in Pi 0.82.1 | Evidence and consequence |
| --- | --- | --- |
| Render an arbitrary component in a full-screen overlay | Public and supported | `ExtensionUIContext.custom()` receives `tui`, `theme`, `keybindings`, and `done` (`dist/core/extensions/types.d.ts:116-125`); overlay semantics are documented at `docs/extensions.md:2672-2733`. |
| Read/set/paste text in the active host editor | Public and supported | `setEditorText`, `getEditorText`, and `pasteToEditor` are declared at `dist/core/extensions/types.d.ts:126-132` and delegate to the current `this.editor` at `dist/modes/interactive/interactive-mode.js:1687-1690`. This is handoff, not embedding. |
| Replace or wrap the globally configured editor factory | Public and supported, but global | `EditorFactory` is declared at `dist/core/extensions/types.d.ts:62`; `setEditorComponent`/`getEditorComponent` at `:165-172`; wrapping guidance at `docs/extensions.md:2761-2784`. |
| Obtain the actual live editor instance | Unavailable | `ExtensionUIContext` has no editor-instance getter. `getEditorComponent()` returns only the configured factory; it returns `undefined` for Pi's default editor. |
| Ask Pi to create another fully wired editor for an overlay | Unavailable | No factory/service accepts caller-owned submit semantics while applying active autocomplete, history, action handlers, appearance, and extension editor wrappers. |
| Layer autocomplete onto the host editor | Public and supported | `addAutocompleteProvider` is declared at `dist/core/extensions/types.d.ts:136` and documented at `docs/extensions.md:2627-2654`. It is a wrapper registration API, not a getter for the resulting provider. |
| Obtain effective slash/path autocomplete | Private implementation | `InteractiveMode.createBaseAutocompleteProvider()` and `setupAutocompleteProvider()` build and assign it at `dist/modes/interactive/interactive-mode.js:345-431`. |
| Enumerate extension/template/skill commands | Public but incomplete for editor reconstruction | `pi.getCommands()` is declared at `dist/core/extensions/types.d.ts:933` and documented at `docs/extensions.md:1526-1557`; built-in interactive commands are intentionally outside this list. |
| Instantiate native user/assistant/tool visual classes | Public package-root exports | Constructor contracts are visible in `dist/modes/interactive/components/user-message.d.ts:5-9`, `assistant-message.d.ts:6-14`, and `tool-execution.d.ts:7-32`. |
| Register this extension's custom message/entry renderer | Public and supported | `registerMessageRenderer` and `registerEntryRenderer` are declared at `dist/core/extensions/types.d.ts:901-903` and documented at `docs/extensions.md:1559-1581`. |
| Look up another extension's effective message/entry renderer | Unavailable to `ExtensionAPI`/`ExtensionContext` | Lookup exists only on `ExtensionRunner` (`dist/core/extensions/runner.d.ts:124-125`) and is used privately by `InteractiveMode` (`interactive-mode.js:2592-2628`). |
| Register a tool definition with call/result renderers | Public and supported | A `ToolDefinition` can carry `renderCall` and `renderResult`; `pi.registerTool()` installs it. |
| Enumerate effective tool definitions/renderers | Unavailable to extensions | `pi.getAllTools()` returns metadata only (`docs/extensions.md:1622-1644`; `dist/core/extensions/types.d.ts:1116-1121`). Full lookup is `AgentSession.getToolDefinition()` (`dist/core/agent-session.js:613-625`), which is not on extension context. |
| Ask the host to render arbitrary foreign session items through its complete pipeline | Unavailable | The orchestration method is private `InteractiveMode.renderSessionItems()` (`interactive-mode.js:2688-2760`); no delegate is exposed by `ctx.ui.custom()`. |
| Replace the parent session with the child session | Public only in command-capable context, architecturally unsafe here | `switchSession` is declared on `ExtensionCommandContext` at `dist/core/extensions/types.d.ts:278-286`; docs describe teardown/rebinding at `docs/extensions.md:1187-1237`. It replaces rather than embeds a session. |

“Unavailable” here means there is no supported public integration point. Private
objects may exist in JavaScript at runtime, but reaching through them or
deep-importing `dist/**` would tie pi-subagents to internal layout, skip Pi's
session lifecycle, and fail the compatibility requirement.

## Native editor and input-event architecture

### What `ctx.ui.custom()` provides

The custom callback gets a TUI object, current theme, keybinding manager, and a
completion callback. In overlay mode Pi calls `ui.showOverlay(component)`; in
non-overlay mode it clears only the editor container and inserts the custom
component (`dist/modes/interactive/interactive-mode.js:1912-1978`). It never
passes the active editor, autocomplete provider, chat container, extension
runner, or session renderer.

Pi saves editor text before opening custom UI and restores/focuses the editor
when a non-overlay custom component closes
(`dist/modes/interactive/interactive-mode.js:1912-1923`). Overlay closure hides
the overlay and leaves the underlying parent surface alive (`:1925-1943`).
This explains why the existing parent-preserving architecture is safe, but it
does not create an embeddable child editor.

### Why `setEditorText()` is a handoff, not editor reuse

`setEditorText()` calls `this.editor.setText(text)` on the live editor
(`dist/modes/interactive/interactive-mode.js:1688`). It is the correct way to
return a command draft to whichever editor is active, including Zentui or
another installed `CustomEditor`. It does not:

- render that editor inside the overlay;
- change the editor's submit destination from the parent agent to a child
  control inbox;
- expose completion results to the overlay; or
- execute a slash command programmatically.

The existing sequence—resolve/close overlay, then set text—is consequently the
right supported slash handoff and should be preserved.

### Why a bare `CustomEditor` is not the native Pi editor

`CustomEditor` is publicly constructible from TUI, editor theme, and
keybindings (`dist/modes/interactive/components/custom-editor.d.ts:6-14`). A
new instance supplies Pi-style editing mechanics, but it does not automatically
receive the active provider, parent history, submit/change callbacks, app-level
actions, image paste, extension shortcuts, padding, border state, or installed
custom-editor wrappers.

Pi adds those behaviors only when installing a factory through
`setCustomEditorComponent()`:

- save/copy text and create the component (`interactive-mode.js:1841-1855`);
- copy submit/change callbacks and appearance (`:1852-1867`);
- inject the effective autocomplete provider (`:1868-1871`); and
- duck-type and copy app-level `CustomEditor` handlers (`:1872-1890`).

That wiring is private and specifically points submit back to the parent
default editor callbacks. Installing a child composer with
`setEditorComponent()` would therefore be both global and incorrectly routed.

### Why calling `getEditorComponent()`'s factory inside the overlay is still incomplete

On this host Zentui installs a non-undefined factory, so the viewer could call
that factory with the overlay's `tui`, editor theme, and keybindings. This would
create a **fresh Zentui-looking editor**, not obtain the live one. Because the
call bypasses `setCustomEditorComponent()`, Pi would not inject the effective
autocomplete provider, parent callback wiring, active history, or copied app
actions. For hosts using Pi's default editor, `getEditorComponent()` is
`undefined`, so even this partial path disappears.

This is not a portable MVP.

### Input-event proxying is not enough

Keeping the real editor under the overlay and forwarding raw key events would
need a public `handleInput` target and a way to intercept submit before the
parent callback. Neither is exposed. `pasteToEditor()` deliberately sends a
bracketed paste sequence; it is not a raw-input forwarding API. Moving focus to
the underlying editor would also make Enter submit to the parent. A terminal
listener can observe/consume keys, but cannot make the live editor into a child
composer without private access and callback mutation.

## Slash-command ownership and semantics

Pi's effective autocomplete is assembled privately:

- built-in interactive commands;
- model and login argument completion;
- prompt templates;
- registered extension command invocation names;
- skills; and
- filesystem completion

are combined in `InteractiveMode.createBaseAutocompleteProvider()`
(`dist/modes/interactive/interactive-mode.js:345-416`). Registered autocomplete
wrappers are then layered and assigned to both default and active editors by
`setupAutocompleteProvider()` (`:417-431`).

Consequences:

1. A local `Input` or freshly-created `CustomEditor` cannot reconstruct parity
   from `pi.getCommands()` because that list excludes built-in interactive
   commands and does not expose the composed filesystem/provider behavior.
2. `addAutocompleteProvider()` allows an extension to add behavior to the host
   provider; it does not return the current provider for reuse.
3. Pi exposes no “execute slash command” API. Many slash commands mutate the
   active session/runtime, so blindly executing a parent command against a
   child would be semantically wrong even if invocation were possible.

The truthful MVP semantics are therefore:

- Text beginning with `/` in the child composer means **leave the child view
  and hand this draft to the real parent editor**.
- The parent editor owns completion, argument completion, command dispatch, and
  any command UI. The child does not claim native slash execution.
- Ordinary text continues to use the existing child steer/follow-up control
  route.
- If child-side slash commands are desired later, they need an explicit child
  command protocol and command allow-list; they are not editor parity.

## Effective message and tool rendering

### Reusable exported primitives

The following can be imported from the package root and placed inside a custom
container:

- `UserMessageComponent(text, markdownTheme?, outputPad?)`;
- `AssistantMessageComponent(message?, hideThinkingBlock?, markdownTheme?,
  hiddenThinkingLabel?, outputPad?)`;
- `CustomMessageComponent(message, customRenderer?, markdownTheme?,
  outputPad?)`; and
- `ToolExecutionComponent(toolName, toolCallId, args, options,
  toolDefinition, ui, cwd)`.

They offer substantial visual reuse, but their signatures also expose the
missing dependencies. A custom message needs the selected renderer. A tool
component needs the effective `ToolDefinition` to use its `renderCall` and
`renderResult`. Assistant settings such as hidden thinking label, output
padding, image display, and markdown settings are selected by
`InteractiveMode`, not globally encapsulated in the component constructor.

### What the private pipeline adds

`InteractiveMode.addMessageToChat()` selects components by message role,
handles skill blocks, applies settings-aware markdown/output padding, adds
history, and looks up custom message renderers
(`dist/modes/interactive/interactive-mode.js:2611-2686`).

`InteractiveMode.renderSessionItems()` additionally:

- iterates compaction-aware items;
- renders an assistant message and extracts its tool calls;
- looks up each registered tool definition;
- creates a `ToolExecutionComponent` with image/settings options;
- matches later `toolResult` messages by `toolCallId` and updates the component;
- tracks pending tools and error/abort states; and
- handles custom entries and cache notices

at `dist/modes/interactive/interactive-mode.js:2688-2760`.

The lookup sources are private runtime objects:

- `InteractiveMode.getRegisteredToolDefinition()` delegates to
  `this.session.getToolDefinition()` (`interactive-mode.js:1345-1347`);
- message/entry lookup uses
  `this.session.extensionRunner.getMessageRenderer/getEntryRenderer`
  (`interactive-mode.js:2592-2628`); and
- those lookup methods appear on internal `ExtensionRunner`, not on
  `ExtensionAPI` (`dist/core/extensions/runner.d.ts:113,124-125`).

Registration is not a global render hook. `registerMessageRenderer()` tells the
current session runner how Pi should render a matching custom type when Pi's
own private pipeline encounters it. It does not cause arbitrary components
inside `ctx.ui.custom()` to consult that registry.

### Parent registry versus child transcript

Even an upstream renderer getter needs an explicit policy. The active parent
registry represents the parent's loaded packages, cwd, settings, and tool
ownership. A child may have different active tools or project-local resources.
Using the parent registry would reproduce the **host's effective display** only
for definitions present there; it cannot truthfully guarantee the exact child
runtime display for child-only tools. Loading the child's extensions again in
the parent process is unsafe because extension initialization has side effects
and assumes one active session.

### Required transcript fidelity

Native assistant and tool components need full finalized message data. The
current reduced live-transcript schema is insufficient. A renderer-oriented
schema should preserve, at minimum:

- complete user/assistant/custom/tool-result message content;
- assistant stop reason and error message;
- tool-call name, ID, complete arguments, and partial/complete status;
- tool result content, error bit, details, and image blocks; and
- stable ordering and a schema version.

The child writer should emit these finalized records into the existing
single-writer live transcript. The parent viewer remains read-only. This avoids
turning the child session JSONL into a shared writable `SessionManager`.

## Installed extension findings

### `pi-tool-display@0.5.0`

The active configuration is
`/home/neko/.pi/agent/extensions/pi-tool-display/config.json:1-27`.
It enables native user-message boxes and owns renderer overrides for `read`,
`ls`, `edit`, and `write`; `grep`, `find`, and `bash` ownership are disabled.
Notably, configured output modes and ownership are per tool, so a viewer that
renders every tool generically is not reproducing this host's effective display.

The extension does three relevant things:

1. It calls `registerToolDisplayOverrides`, `registerNativeUserMessageBox`, and
   thinking-label setup from
   `/home/neko/.pi/agent/npm/node_modules/pi-tool-display/src/index.ts:62-78`.
2. For owned built-ins it creates replacement runtime tool definitions carrying
   `renderCall`/`renderResult` and registers them with `pi.registerTool()`
   (`src/tool-overrides.ts:1579-1910`; the thin registration call is at
   `:206-208`). These effective definitions end up in Pi's private tool
   registry.
3. It wraps `pi.registerTool` to decorate later custom/MCP tool objects and also
   exposes a package-specific `Symbol.for("pi-tool-display.api.v1")` decoration
   API (`src/tool-overrides.ts:147-208,1491-1567,2038-2075`). The public consumer
   API decorates a tool object supplied by the caller; it does not enumerate or
   return the active registered definitions.

For user messages it directly patches the exported
`UserMessageComponent.prototype`
(`/home/neko/.pi/agent/npm/node_modules/pi-tool-display/src/user-message-box-native.ts:1-58`).
Consequently, a viewer-created `UserMessageComponent` in the same module realm
can inherit this style without renderer lookup. This is a global prototype side
effect, not a supported cross-extension rendering contract.

### `pi-zentui@0.15.0`

The active `/home/neko/.pi/agent/zentui.json:1-22` enables `features.editor`
and disables the optional fixed editor compositor.

Zentui:

1. reads the currently configured factory and installs either a standalone
   `PolishedEditor` or a wrapper around another custom factory with
   `ctx.ui.setEditorComponent()`
   (`/home/neko/.pi/agent/npm/node_modules/pi-zentui/extensions/zentui/index.ts:286-374`);
2. builds `PolishedEditor` on public `CustomEditor`, while
   `WrappedPolishedEditor` forwards editor methods to a base component
   (`extensions/zentui/ui.ts:375-425,427-598`);
3. installs its footer independently through `ctx.ui.setFooter()`
   (`extensions/zentui/footer.ts:179`); and
4. patches `UserMessageComponent.prototype.render` and `invalidate`
   (`extensions/zentui/user-message.ts:211-248`).

The installed Zentui editor factory is therefore visible through
`getEditorComponent()`, but invoking it creates a new instance and bypasses
Pi's private wiring. The footer and optional fixed-editor compositor modify the
live host layout; they are not inherited by a component tree inside the steer
overlay.

Because settings list tool-display before Zentui, both user-message patches may
be active in a chain. Zentui's patch wraps the predecessor and normally returns
its own rendered lines. A reused `UserMessageComponent` therefore inherits the
current load-order-dependent global patch chain, not a selectable “effective
renderer.” This behavior must be treated as opportunistic and covered by a
compatibility test, not promised as a stable Pi API.

## Session switching and file safety

### `switchSession()` is replacement, not embedding

Pi exposes session switching only on a command-capable context. Switching emits
shutdown/start lifecycle, replaces the session/runtime, and invalidates objects
captured from the old context (`docs/extensions.md:1187-1237`). Using it to view
a child would tear down or rebind the parent subagent extension that owns the
run, contradict parent authority and making return-to-parent state restoration
fragile. It remains out of scope.

### `SessionManager.open()` is not a guaranteed read-only parser

`SessionManager.open(path)` is public SDK API
(`dist/core/session-manager.d.ts:318-331`), but an opened manager is persistent
and writable. During `_setSessionFile`, Pi initializes empty files and migrates
older session versions by rewriting the file
(`dist/core/session-manager.js:611-640`); `_rewriteFile()` opens the path for
write at `:693-704`.

Therefore opening a live child session from the parent is not safe merely
because viewer code intends to call only getters. It can become a second writer
or perform a migration rewrite while the child owns the file.

### Safe data boundary

The safe architecture is unchanged:

- child process is the sole writer of its Pi session;
- child/live-transcript writer emits viewer records;
- parent viewer performs bounded, path-validated direct reads/tails;
- parent sends conversation/control requests through the existing inbox; and
- no parent `SessionManager` attaches to the child file.

Directly reading the child session file can remain a best-effort terminal
fallback, but native rendering should prefer the versioned structured live
transcript. A raw session tail must also account for partial final lines,
branches, compaction, schema migration, and records not on the active branch.

## Architecture options and trade-offs

| Option | Editor parity | Renderer parity | Parent/session safety | Extension compatibility | Decision |
| --- | --- | --- | --- | --- | --- |
| A. Keep current overlay, local `Input`, manual Markdown/text | Low | Low | High | Preserves host state; no render reuse | Current safe baseline, but does not meet the improvement goal alone. |
| B. Hybrid overlay: local composer + exported native message components + generic tool fallback | Medium visual parity; low native editor parity | Medium for standard user/assistant messages; explicit fallback for tools/custom types | High | Inherits same-realm prototype patches opportunistically; no private registry access | **Recommended MVP.** |
| C. Instantiate `getEditorComponent()` factory inside overlay | Superficially similar where a custom factory exists; missing provider/history/wiring | Unchanged | Medium | Host-dependent; unavailable with default editor; bypasses Pi wiring | Reject as portable architecture; useful only as a throwaway diagnostic spike. |
| D. Construct bare `CustomEditor` inside overlay | Better multiline/keybinding base than `Input`; not actual effective editor | Unchanged | High | Does not inherit third-party editor wrapper or active autocomplete | Possible fallback experiment, but must not be called native parity. |
| E. Temporarily call `setEditorComponent()` for child mode | Uses host installation path but Pi overwrites submit with parent callbacks; global surface mutation | Unchanged | Low | Competes with Zentui/other editor owners and reconciliation | Reject. |
| F. Proxy overlay keys to live underlying editor | Potential parity only with private instance/callback mutation | Unchanged | Low | Focus and listener ordering conflicts; submit targets parent | Unavailable through public API; reject. |
| G. `switchSession()` or open child session in parent | Native only by replacing parent | Native for replacement session | Unacceptable | Tears down/rebinds extensions; concurrent-write/migration risk | Reject. |
| H. Import/reflect into `InteractiveMode` private fields | Potentially high for one Pi build | Potentially high for one Pi build | Low | Brittle across versions/module realms | Reject. |
| I. Upstream host-managed embedded editor + transcript-render delegate | High | High | Can be high if designed read-only | Can use effective host registry with explicit child mismatch policy | Correct long-term route. |

## Recommended MVP

Implement a **supported hybrid conversation surface** in a later development
task, with the following explicit boundaries:

1. Preserve the existing full-screen capturing overlay and parent runtime.
2. Preserve the existing child inbox/control route for ordinary submissions.
3. Preserve the local child composer for MVP. It may remain `Input`, or a bare
   public `CustomEditor` may be separately evaluated for multiline/keybinding
   improvements, but UI text and acceptance criteria must not call it the
   actual host editor.
4. Preserve exact slash handoff: close the overlay, then call
   `ctx.ui.setEditorText()` so the actual current editor—including Zentui and
   its effective autocomplete—takes ownership.
5. Version and enrich the structured live transcript with complete finalized
   Pi message/tool data; do not attach a `SessionManager` to the child file.
6. Add a small viewer-owned transcript assembler that:
   - uses exported `UserMessageComponent` for standard user text;
   - uses exported `AssistantMessageComponent` for complete assistant messages;
   - pairs tool calls/results by ID;
   - uses `ToolExecutionComponent` only after a prototype confirms the
     undefined-definition generic path is stable and clearly labels it as
     generic; and
   - falls back to current bounded Markdown/Text rendering for malformed,
     legacy, custom, or unsupported records.
7. Do not claim effective tool-display renderer reuse. On this host, standard
   user components may inherit the active tool-display/Zentui prototype chain;
   tool calls remain generic until Pi exposes definitions/render delegation.
8. Keep widgets, footer, and host session state untouched beneath the overlay.
   A full-screen overlay can obscure them visually while open, but must not
   unregister or recreate them.

This MVP produces meaningful native visual consistency and richer conversation
fidelity without private APIs. It truthfully defers two requirements:

- actual effective editor embedding/completion inside the child view; and
- exact effective renderer reuse for tools and extension-defined messages.

If product acceptance requires those two items rather than the hybrid, the
task is blocked on upstream API work and should not substitute private imports.

## Smallest upstream API gaps

### 1. Host-managed editor creation/lease

The smallest useful editor API is not a getter for the live component, because
the live component already belongs to the parent editor container and has
parent-specific callbacks. Pi should instead expose a host-managed constructor
or lease, for example:

```ts
ctx.ui.createEditor({
  onSubmit,
  onChange,
  initialText,
  historyScope: "isolated",
  slashMode: "handoff" | "disabled" | "host",
}): EditorComponent
```

Pi would apply the active custom editor factory/wrapper, effective autocomplete
provider, keybindings, appearance, IME/paste behavior, and safe action-handler
policy, while allowing caller-owned submit routing. The API must specify
whether built-in app actions target the parent session and must support an
isolated history so child prompts do not pollute parent history.

An alternative is `ctx.ui.custom(..., { editor: { ... } })`, where Pi owns
placement and lifecycle. Merely exposing `this.editor` or the autocomplete
object would encourage component reparenting and callback mutation and is not
recommended.

### 2. Effective transcript renderer delegate

Pi should expose a renderer service rather than each private registry, for
example:

```ts
const view = ctx.ui.createTranscriptView({
  messages,
  cwd,
  registry: "active-host",
  readOnly: true,
});
```

or a lower-level `renderSessionItems(items, options)` delegate. It should own
tool-call/result pairing, settings, expansion, images, custom message/entry
renderer lookup, and invalidation. The contract must state that
`registry: "active-host"` uses parent definitions and how unknown child tools
fall back. It must not require loading a second extension runtime or opening a
writable child `SessionManager`.

If Pi prefers smaller primitives, the minimum set is:

- a public read-only `getToolDefinition(name)`;
- public read-only `getMessageRenderer(customType)` and
  `getEntryRenderer(customType)`;
- a public settings snapshot for message/tool display; and
- a supported tool-call/result assembler.

The composite delegate is safer because it prevents every extension from
copying `InteractiveMode.renderSessionItems()` and drifting with Pi internals.

### 3. Read-only session parsing (secondary)

A public `parseSessionFileReadOnly(path)` that never creates, migrates, or
rewrites would improve terminal fallback. It still would not solve live branch
selection or renderer registry access, so it is secondary to the structured
live transcript and render delegate.

## Validation prototypes for the implementation phase

These are deliberately small, independently reviewable spikes. They should be
implemented as tests/fixtures or throwaway test harnesses, not shipped private
API dependencies.

### Prototype P1 — editor factory boundary

In a test extension, record `ctx.ui.getEditorComponent()` with:

1. no custom editor installed; and
2. Zentui installed.

Instantiate the returned Zentui factory only in the test harness and assert:

- default Pi returns no factory;
- Zentui returns a fresh editor component;
- direct factory invocation has no host-injected autocomplete observable and
  no parent history; and
- installing through `setEditorComponent()` causes Pi to overwrite/wire
  callbacks, proving the distinction.

Success validates that factory embedding is not a portable implementation.

### Prototype P2 — slash handoff with effective editor

With Zentui and an extension autocomplete provider installed:

1. open the child overlay;
2. enter `/` text;
3. assert the overlay resolves before `setEditorText()`;
4. assert the real editor receives the complete draft and shows both built-in
   and extension completion; and
5. assert parent text/focus is preserved across cancel/reopen.

The current ordering assertion at
`test/integration/steer-view-entry.test.ts:25-57` is the starting point.

### Prototype P3 — native standard messages and patch chain

Feed complete user and assistant fixture messages to viewer-created package-root
components. Run once with no display extensions and once with the installed
tool-display/Zentui patch order. Assert:

- wrapping and ANSI-visible width remain bounded;
- thinking visibility follows the supplied setting;
- standard user rendering changes when the prototype patches are installed;
- component disposal/reopen does not duplicate patches; and
- a malformed/legacy record uses the generic fallback rather than crashing.

This validates only standard component reuse, not a renderer-registry promise.

### Prototype P4 — generic tool fallback

Create complete assistant tool-call and matching tool-result fixtures. Verify
whether public `ToolExecutionComponent(..., undefined, ...)`:

- renders a stable generic call/result;
- handles partial, error, image, and expanded states without a definition; and
- updates by `toolCallId` without leaking components.

If any case is unstable, retain the viewer's own generic tool rows. Do not reach
into `AgentSession.getToolDefinition()`.

### Prototype P5 — transcript concurrency and schema compatibility

While a child fixture appends finalized records:

- repeatedly tail from the viewer;
- inject a partial final JSON line;
- rotate/truncate/recreate the live transcript;
- include a legacy simplified record and a new versioned full record; and
- assert no viewer operation writes the child session file.

The test should monitor inode/mtime/content of the session file and fail if a
parent-side `SessionManager.open()` or rewrite occurs.

### Prototype P6 — renderer gap characterization

Register a custom message renderer and a custom tool renderer in a test
extension. Render matching foreign records inside `ctx.ui.custom()` using only
public context. Assert that:

- registration affects Pi's main chat;
- it does not automatically affect the arbitrary overlay component;
- `getAllTools()` lacks `renderCall`/`renderResult`; and
- no public renderer lookup exists.

This is the regression evidence for the upstream request.

## Planning acceptance boundaries

A later implementation can be accepted as the hybrid MVP only if it states and
tests all of the following:

- parent session/runtime is never switched or replaced;
- child session file has one writer and is never opened by a persistent parent
  `SessionManager`;
- ordinary text routes only to the selected child;
- slash text routes only to the real parent editor after overlay closure;
- native standard components have complete inputs and bounded fallback;
- tool/custom renderer fallback is visible and truthful;
- default editor, Zentui editor, and another custom-editor wrapper are covered;
- tool-display/Zentui prototype interaction is covered without relying on
  patch order as a public contract; and
- no private `dist/**` imports or `InteractiveMode` field reflection ship in
  product code.

## Residual risks

- Exported native component constructors are public today, but Pi does not
  document them as a stable transcript-render service. Pinning and compatibility
  tests remain necessary.
- Installed extensions can patch exported component prototypes globally.
  Multiple patch owners are load-order-sensitive and may not compose cleanly.
- Parent effective renderers can differ from a child's tool/resource set even
  after an upstream getter is added.
- A richer finalized live transcript increases artifact size and needs explicit
  redaction/truncation policy for tool arguments/results.
- A bare `CustomEditor` may improve editing but still lacks effective completion,
  installed wrappers, and safe app-action semantics; product wording must remain
  precise.
- `pi-tool-display@0.5.0` does not declare Pi 0.82 support.

## Final recommendation

Proceed with the supported hybrid only: parent-preserving overlay, isolated
child composer/control channel, slash handoff to the actual parent editor,
versioned full-fidelity live records, exported native user/assistant visual
components, and explicit generic fallbacks. Do not use `switchSession()`,
`SessionManager.open()` on a live child, global editor replacement, private
`InteractiveMode` fields, or deep `dist/**` imports.

Treat actual embedded editor parity and effective tool/custom renderer parity
as separately reviewable upstream Pi API work. That is the smallest architecture
that improves fidelity now without making unsupported claims or weakening
session safety.
