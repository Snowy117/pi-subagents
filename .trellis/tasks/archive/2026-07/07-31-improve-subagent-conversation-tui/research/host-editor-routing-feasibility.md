# Host editor routing feasibility

## Purpose

This note supplements `pi-native-editor-renderer-feasibility.md`. That report
correctly establishes that Pi 0.82.1 does not expose the live editor instance
or a fully wired editor factory for embedding inside `ctx.ui.custom()`. It does
not, however, rule out using the live host editor **in its existing location**
while a subagent conversation mode is active.

## Supported mechanism

Pi exposes all pieces needed for a parent-preserving host-editor routing mode:

1. `ctx.ui.setWidget()` can mount a component above the real editor without
   replacing that editor (`dist/core/extensions/types.d.ts:91-98` and
   `dist/modes/interactive/interactive-mode.js:1462-1497`). A component factory
   is not subject to the ten-line truncation applied to string-array widgets.
2. Pi TUI overlays also support `OverlayOptions.nonCapturing`, which leaves
   focus on the pre-existing editor (`pi-tui/dist/tui.d.ts:76-103` and
   `pi-tui/dist/tui.js:290-302`). This is useful for temporary chrome, but an
   above-editor widget is the more layout-safe transcript surface because an
   overlay can visually cover a variable-height editor/autocomplete menu.
3. `pi.on("input")` can return `{ action: "handled" }` after receiving raw
   interactive input (`dist/core/extensions/types.d.ts:621-640` and
   `docs/extensions.md:885-923`). The selected child route can therefore consume
   ordinary host-editor submissions without appending them to the parent
   conversation.
4. The real `Editor` clears its text, exits history browsing, and calls its
   installed submit callback in `submitValue()`
   (`pi-tui/dist/components/editor.js:1057-1071`). Pi's interactive submit
   handler also records normal submissions in that same editor's history
   (`pi-coding-agent/dist/modes/interactive/interactive-mode.js:2095-2276`).
5. The parent `AgentSession.prompt()` invokes extension commands first, then the
   `input` event, then skill/template expansion
   (`pi-coding-agent/dist/core/agent-session.js:786-831`). A handled input ends
   parent processing without starting a parent model turn.

This means the live host editor can remain exactly where Pi and installed
extensions own it. No editor component is cloned, reparented, or globally
replaced. Zentui's installed editor factory, Pi's composed slash/path
autocomplete, history, multiline editing, paste behavior, IME handling, and
editor wrappers continue to operate on the same live instance.

## Proposed data flow

```text
/subagents picker
  -> activate selected-child conversation mode
  -> mount read-only transcript component above the host editor
  -> keep focus on the existing host editor

ordinary editor submit
  -> Pi AgentSession.prompt()
  -> pi-subagents input handler sees active child target
  -> sendTargetSteer()/resume route
  -> return { action: "handled" }
  -> parent agent receives no user message and starts no turn

slash editor submit
  -> built-in or extension command executes in the parent before input, or
  -> input handler returns { action: "continue" } for skill/template expansion
```

## Important boundaries

- This reuses the actual host editor, not an embedded editor.
- The active mode must be clearly visible in the transcript header and editor
  status/border text so the user knows ordinary input is routed to a child.
- A reliable command must exit or switch the child route. Relying on Escape is
  unsafe because Escape also closes autocomplete and controls the parent agent.
- Parent built-in and extension slash commands run before the `input` event.
  They cannot be redirected to a headless child by this mechanism.
- Skill and prompt-template slash forms reach the input event before expansion;
  the mode must choose explicitly whether all leading slash text belongs to the
  parent or whether a narrower allow-list is used.
- `!` bash commands are handled by `InteractiveMode` before normal prompt
  routing (`interactive-mode.js:2228-2243`), so they naturally remain parent
  TUI commands unless Pi adds a pre-command routing hook.
- While the parent is streaming, Pi calls `session.prompt(...,
  { streamingBehavior: "steer" })`; the same input handler can return handled,
  but tests must prove this does not disturb the parent queue display.
- Input handlers are session-wide. They must gate on an explicit active child
  mode and return `continue` unchanged otherwise.

## Transcript surface choice

An above-editor component widget is preferred over a full-screen capturing
overlay:

- it preserves the real editor's focus and autocomplete placement;
- it composes with another extension's editor factory;
- it does not require private focus targets; and
- it can be removed without restoring or copying editor state.

A non-capturing overlay remains a possible visual spike. It must reserve enough
bottom space for a variable-height editor and autocomplete popup. Pi exposes no
public editor-height measurement, so a nominal full-screen non-capturing
overlay risks painting over the editor and is not the default design.

The widget should render a bounded, viewport-oriented transcript. It must not
assume ownership of the whole root TUI or remove other extensions' widgets.
The implementation needs a compatibility spike with Zentui's optional fixed
editor compositor because that extension reflects into Pi's root layout.

## Renderer implications

Host-editor routing solves editor parity only. It does not expose Pi's private
effective renderer registries. The renderer plan from
`pi-native-editor-renderer-feasibility.md` still applies:

- enrich the structured child transcript with complete finalized messages and
  tool call/result identity;
- use package-root `UserMessageComponent` and
  `AssistantMessageComponent` for standard messages;
- treat same-realm Zentui/tool-display user-message prototype patches as
  opportunistic compatibility;
- use explicit generic tool/custom-message fallbacks until Pi exposes a
  read-only effective transcript renderer delegate.

## Prototype gate

Before implementing the complete mode, add one focused integration prototype:

1. install a fake custom editor and autocomplete provider;
2. activate a fake child target and mount the transcript widget;
3. submit ordinary text and assert exactly one child send, `{ handled }`, no
   parent message, editor clearing, and host history retention;
4. submit a built-in, extension, skill, and template slash form and assert the
   chosen parent ownership semantics;
5. repeat while the parent is streaming;
6. close the mode and assert the same editor factory, text, focus, widgets, and
   footer remain active.

If Pi's event ordering differs under the real harness, fall back to the isolated
composer design; do not mutate private `InteractiveMode` callbacks.

## Recommendation

Use the host-editor routing mode as the preferred MVP architecture, subject to
the prototype gate. It is the only public Pi 0.82.1 path found that can inherit
the **actual** active editor, Zentui wrapper, and effective completion provider
without replacing the parent session or depending on private fields.

