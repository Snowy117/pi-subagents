# Slash commands, subagent exit handling, and keybindings

## Scope and baseline

This note covers the package's current command surface, how the active
subagent/host-editor view exits today, the built-in picker shortcut, and what
Pi 0.83.0 actually permits through `~/.pi/agent/keybindings.json`.

The installed host dependencies are Pi 0.83.0 (`package.json:71-79`). The host
details below therefore describe the API and behavior this repository is
currently compiled and tested against.

## 1. Current package-provided slash-command surface

### 1.1 Extension registration path

- The root extension imports the slash-command barrel and registers commands
  after the tools/bridges have been constructed (`src/extension/index.ts:28`,
  `src/extension/index.ts:252-263`). Child Pi processes return before any of
  this package's extension registrations occur (`src/extension/index.ts:62-65`).
- The barrel is only a re-export (`src/slash/slash-commands.ts:1`). The actual
  orchestrator is `registerSlashCommands()`
  (`src/slash/commands/registration.ts:12-62`).

There are **14 explicit `pi.registerCommand()` calls** in current source:

| Command | Registration |
|---|---|
| `/run` | `src/slash/commands/execution-commands.ts:13-41` |
| `/parallel` | `src/slash/commands/execution-commands.ts:43-65` |
| `/subagent-cost` | `src/slash/commands/registration.ts:20-25` |
| `/subagents-doctor` | `src/slash/commands/registration.ts:27-32` |
| `/subagents-fleet` | `src/slash/commands/registration.ts:34-39` |
| `/subagents` | `src/slash/commands/registration.ts:41-54` |
| `/prompt-workflow` | `src/slash/prompt-workflows.ts:144-176` |
| `/chain-prompts` | `src/slash/prompt-workflows.ts:178-204` |
| `/subagents-models` | `src/slash/commands/profile-commands.ts:33-54` |
| `/subagents-profiles` | `src/slash/commands/profile-commands.ts:56-66` |
| `/subagents-load-profile` | `src/slash/commands/profile-commands.ts:68-119` |
| `/subagents-refresh-provider-models` | `src/slash/commands/profile-commands.ts:121-153` |
| `/subagents-generate-profiles` | `src/slash/commands/profile-commands.ts:155-191` |
| `/subagents-check-profile` | `src/slash/commands/profile-commands.ts:193-223` |

`registerSlashCommands()` fans out to all of these surfaces: execution first,
four direct registrations including `/subagents`, prompt workflows, then
profiles (`src/slash/commands/registration.ts:18-61`). To leave only
`/subagents`, simplifying the direct block alone is insufficient; the three
fan-out calls/imports also have to stop registering their commands.

Current source does **not** register `/chain` or `/run-chain`; only `/run` and
`/parallel` remain in `registerExecutionCommands()`
(`src/slash/commands/execution-commands.ts:9-66`). Tests and documentation that
still dereference `/chain` and `/run-chain` are stale relative to source; see
the test section below.

### 1.2 Packaged prompts are an additional slash-invocable surface

The package manifest exposes `./prompts` as a Pi resource
(`package.json:44-53`) and publishes `prompts/**/*` (`package.json:28-35`). The
directory currently contains:

- `prompts/gather-context-and-clarify.md`
- `prompts/parallel-cleanup.md`
- `prompts/parallel-context-build.md`
- `prompts/parallel-handoff-plan.md`
- `prompts/parallel-research.md`
- `prompts/parallel-review.md`
- `prompts/review-loop.md`

Pi reads the package's `pi` manifest and adds each declared resource path
(`node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js:1747-1770`,
`node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js:1849-1888`).
Prompt Markdown basenames become template names
(`node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js:81-104`),
and a leading `/name` expands that template
(`node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js:217-225`).
The interactive UI explicitly presents loaded templates as `/name`
(`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1133-1148`).

Therefore the acceptance statement “`/subagents` is the only
package-provided slash command” has two independently loaded surfaces:

1. explicit extension commands registered through `pi.registerCommand()`;
2. packaged prompt templates invoked through slash syntax.

If the prompt recipe files are retained but should no longer be exposed, an
explicit `"prompts": []` manifest entry is safer than merely deleting the
`pi.prompts` property. With a package filter present, Pi's
`collectDefaultResources()` falls back to a convention-named `prompts/`
directory when the manifest entry is absent
(`node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js:1786-1800`).
An empty array is truthy in that branch, so it prevents the convention
fallback while contributing no prompt files. Removing/moving the published
`prompts/` directory is the other unambiguous option.

### 1.3 Documentation surface to update

Current user-facing documentation presents much more than `/subagents`:

- the skill lists the execution, diagnostic, profile, and prompt-workflow
  commands (`skills/pi-subagents/SKILL.md:32-44`);
- it documents the Down shortcut (`skills/pi-subagents/SKILL.md:49-53`);
- it presents all seven packaged prompt shortcuts
  (`skills/pi-subagents/SKILL.md:55-62`);
- the README documents/configures Down (`README.md:192-204`);
- the README's optional-shortcut table lists all seven package prompts
  (`README.md:315-329`);
- the main command table lists `/run`, stale `/chain`, `/parallel`, stale
  `/run-chain`, and utility/profile commands (`README.md:438-456`);
- the native adapter section documents `/prompt-workflow` and `/chain-prompts`
  (`README.md:1490-1520`).

Historical changelog entries can remain historical. Current README/skill
instructions and any generated command tables should be the cleanup target.

## 2. Existing subagent-view exit path

### 2.1 `/subagents exit` is the only package-owned close command

`/subagents exit` and `/subagents close` share the same handler. It closes the
host-editor conversation, closes any steer-view modal, notifies, and returns
(`src/slash/commands/registration.ts:41-54`). The integration test only pins
the host-editor half of this path (`test/integration/steer-view-entry.test.ts:123-144`).

The host-editor close operation is a meaningful teardown, not just a mode
flag: it removes the widget, clears status, disposes the assembler/command
validator, resets stream/display state, ends the viewer conversation, and
clears the current channel/target/context
(`src/tui/steer-view/host-editor-mode.ts:233-262`). Its public handle exposes
`close(ctx)` (`src/tui/steer-view/host-editor-mode.ts:38-50`). This is the
operation that an intercepted exit action should reuse, ideally through one
shared “exit subagent view” function also used by `/subagents exit` so the
paths cannot drift.

### 2.2 Submitted input routing cannot intercept the host's quit command

While child mode is active, the root extension routes Pi `input` events into
`hostEditorConversation.routeInput()` (`src/extension/index.ts:190-194`). That
router intentionally returns `continue` for any single-slash command so the
parent runtime owns it (`src/tui/steer-view/host-editor-mode.ts:299-335`), and
tests pin `/help`/`!bash` as parent-owned
(`test/unit/host-editor-mode.test.ts:238-255`).

This is useful for extension commands such as `/subagents exit`, but it does
not make the input event a general quit interception point. In Pi 0.83.0 the
built-in quit command is recognized by the interactive mode itself as
`/quit`, which calls `shutdown()` and returns before normal submitted input is
queued (`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:2232-2236`,
`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:2276-2286`).
The built-in command list contains `/quit`, not `/exit`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js:2-25`).

The host changelog explicitly records that `/exit` was removed in favor of
`/quit` (`node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md:1704`,
`node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md:2591`). Thus the
task wording “cover `/exit`” does not match the installed runtime. If it means
“cover the normal slash quit path,” the concrete current path is `/quit`.

### 2.3 There is no cancellable semantic exit event in the public extension API

The public event list includes `input` and a post-decision
`session_shutdown`, but no `before_exit`, `app_action`, or cancellable quit
event (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:855-888`).
`session_shutdown` is documented as firing when the runtime is being torn
down and its result has no cancellation/redirect contract
(`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:462-468`).
By the time interactive shutdown disposes the runtime, the process is already
committed to terminating
(`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:2871-2911`).

This is a design-significant mismatch with the constraint to intercept the
“shared exit action/event.” On Pi 0.83.0, no such public semantic hook exists.
The package-level mechanism available before the editor acts is raw terminal
input via `ctx.ui.onTerminalInput()`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:49-53`,
`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:68-78`).
Pi installs those callbacks as TUI input listeners
(`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1643-1680`).

### 2.4 The canonical `app.exit` key action can be intercepted safely

Pi's current keybinding table defines `app.exit` with default `ctrl+d`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js:5-10`).
Legacy `exit` is migrated to `app.exit`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js:181-184`).
The manager loads `<agentDir>/keybindings.json` and reloads it into the live
manager (`node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js:270-294`);
the user docs identify the file, `/reload`, and `app.exit`
(`node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md:1-9`,
`node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md:81-90`).

The main editor resolves raw data with `keybindings.matches(data,
"app.exit")`, and only exits when the editor is empty. With text present, the
same key falls through to normal delete-char-forward behavior
(`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js:49-58`).
The handler then calls shutdown
(`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:2047-2050`,
`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:2867-2870`).

The package already has the correct parity pattern for other app actions:
`createChildKeybindings()` uses the global `getKeybindings()` manager rather
than hard-coded keys (`src/tui/child-conversation/child-keybindings.ts:1-22`,
`src/tui/child-conversation/child-keybindings.ts:92-120`). This inherits
defaults, user remaps/removals, legacy migration, live reload, multiple keys,
and runtime `matches()` patches. Unit coverage exists for all of those
properties (`test/unit/child-keybindings.test.ts:38-165`).

However, `app.exit` is not in the seven-action child map
(`src/tui/child-conversation/child-keybindings.ts:25-67`) and the child key
route has no exit branch (`src/tui/steer-view/child-key-route.ts:198-231`). A
test explicitly asserts that Ctrl+D is not intercepted
(`test/unit/child-key-route.test.ts:222-228`). Today, while child mode is
active, Ctrl+D or a user-remapped `app.exit` therefore continues to the main
editor and can terminate the parent process.

A package-level exit-key route can match the main editor's semantics if it:

1. runs only while `hostEditorConversation.active` is true;
2. resolves the raw key through the live global manager's `app.exit`, never a
   hard-coded Ctrl+D check;
3. checks `ctx.ui.getEditorText().length === 0` before consuming, preserving
   delete-char-forward when text is present;
4. invokes the same shared teardown as `/subagents exit` and returns
   `{ consume: true }`;
5. is ordered before the remaining child app-action router, mirroring
   `CustomEditor`'s exit-before-other-actions priority.

The steer runtime already centralizes terminal-handler order and consumption
(`src/tui/steer-view/registration.ts:53-71`), so it is the natural integration
point for such a raw-action route.

### 2.5 Slash quit and double-Ctrl+C remain separate host paths

Raw `app.exit` interception alone does not satisfy a literal “every normal
exit path” criterion on this host:

- `/quit` is parsed directly by interactive mode before extension input, as
  described above;
- the second `app.clear`/Ctrl+C within 500 ms also calls shutdown directly
  (`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:2857-2865`).

Neither is a public semantic `app.exit` event. A package can technically
special-case raw submission when the editor contains `/quit` (and legacy
`/exit`) or mirror the double-Ctrl+C state machine, but those are host-behavior
reimplementations and conflict with the stated preference for a shared exit
action/event. The clean, fully general solution requires an upstream
cancellable `before_exit`/app-action hook, or an editor action-handler API
that lets the active view temporarily handle the canonical exit operation.
Without that host addition, design should explicitly distinguish:

- **achievable package-only parity:** `app.exit`, including custom/remapped
  bindings and empty-editor semantics;
- **additional text/state special cases:** `/quit` (and requested legacy
  `/exit`) plus double-Ctrl+C;
- **true shared-path parity:** requires host API support.

## 3. Current picker-opening shortcut

### 3.1 Down is hard-coded and enabled by default

`handleSubagentsDown()` uses raw `matchesKey(input, Key.down)`. It opens only
when all of these are true: the config flag is enabled, the key is Down, no
package modal is open, the editor is empty, and an active view target exists
(`src/tui/steer-view/entry-shortcut.ts:7-22`). It consumes the key after
starting the asynchronous open.

The default config explicitly enables the behavior
(`src/extension/config.ts:11-18`). This is a package-specific config under
`~/.pi/agent/extensions/subagent/config.json`
(`src/extension/config.ts:7-9`), not `keybindings.json`.

At session start the steer runtime installs the Down handler first, then the
child app-action router, in one `onTerminalInput` listener
(`src/tui/steer-view/registration.ts:53-71`). This is the complete current
picker shortcut path; there are no `pi.registerShortcut()` calls in package
source.

Removing the built-in shortcut means removing this raw Down handler from the
runtime and retiring (or making inert for compatibility) the
`tui.openSubagentsOnDown` config. Merely changing the default to `false` would
remove the default behavior but leave a second extension-specific shortcut
configuration system; that is at odds with the stated `keybindings.json`
extensibility goal unless retained only as a temporary compatibility shim.

## 4. What `keybindings.json` can and cannot extend in Pi 0.83.0

### 4.1 Existing action IDs are fully remappable

For an action already present in the runtime definition table, Pi supports:

- one key or multiple keys;
- remapping a default;
- `[]` to remove all bindings;
- legacy-name migration;
- `/reload` into the live manager.

The package already depends on these semantics for child app actions and has
focused tests (`test/unit/child-keybindings.test.ts:38-119`). Reusing the same
global manager for `app.exit` is therefore robust and is the required way to
preserve user-configured exit shortcuts.

### 4.2 Unknown action IDs are ignored at runtime

The Pi TUI manager receives a fixed runtime `definitions` object. During
rebuild it ignores every user keybinding whose id is absent from that object
(`node_modules/@earendil-works/pi-tui/dist/keybindings.js:97-129`), and
`matches()`/`getKeys()` return no keys for unknown IDs
(`node_modules/@earendil-works/pi-tui/dist/keybindings.js:131-143`).

Declaration merging is advertised for the TypeScript `Keybindings` interface
(`node_modules/@earendil-works/pi-tui/dist/keybindings.d.ts:1-6`), but it only
changes the accepted type. It does not insert a runtime definition. The
definition map and rebuild method are private in the public declaration
(`node_modules/@earendil-works/pi-tui/dist/keybindings.d.ts:176-189`).

Pi 0.83.0's coding-agent definition table has no package/picker action such as
`app.subagents.open` (`node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js:5-109`).
Consequently, adding this to a user's file today does nothing:

```json
{
  "app.subagents.open": "ctrl+down"
}
```

The global manager will ignore it because the runtime action does not exist.

### 4.3 `registerShortcut()` does not bridge this gap

The extension API accepts a raw `KeyId`, not an action id
(`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:891-897`).
The loader stores the literal shortcut as a map key
(`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:203-214`),
and the runner performs conflict resolution over those raw keys
(`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:319-347`).
The host changelog states this explicitly: `registerShortcut()` remains raw
key combos, not keybinding IDs
(`node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md:2002`).

Therefore `pi.registerShortcut("ctrl+down", ...)` can create a fixed package
shortcut and display it in `/hotkeys`, but users cannot remap it through
`keybindings.json`. It also would violate the “no picker shortcut by default”
requirement if the package supplied that literal key.

### 4.4 Feasible design choices

**A. Upstream/runtime action (best semantic integration).** Add a canonical
action such as `app.subagents.open` to Pi's runtime `KEYBINDINGS` table with
`defaultKeys: []`, plus a public action-handler/registration mechanism if
needed. The package then uses the global manager and a terminal/action handler.
Benefits: native validation, conflict reporting, `/hotkeys`, `/reload`, arrays,
and any manager patches. Cost: requires a host/API change and a minimum host
version.

**B. Package-owned `keybindings.json` adapter (package-only).** Document an
extension-specific key (for example `app.subagents.open`), read that entry
directly from `<agentDir>/keybindings.json`, validate string/string-array/`[]`,
and match raw input in the existing terminal listener. With no entry there is
no default shortcut. Extension reload can re-read it. Cost: the core manager
will still ignore the id, so the package must recreate validation/conflict
semantics; it will not automatically inherit manager migration or runtime
patches (notably leader-key-style `matches()` behavior) unless implemented
deliberately.

**C. Private manager mutation (not recommended).** Runtime JS happens to retain
mutable `definitions`, but the declaration marks it private and exposes no
registration method. Mutating it/rebuilding user bindings would rely on
private implementation details and is brittle across host versions.

**D. Reuse an unrelated existing no-default action (not recommended).** Actions
such as `app.session.new/tree/fork/resume` are configurable, but assigning one
to the picker gives one key two unrelated meanings and can create order-based
behavior conflicts.

Given the explicit requirement that the shortcut live in
`keybindings.json`, design must choose A or B. Current public APIs do not make
the requirement automatic.

## 5. Likely automated-test changes

### 5.1 Exact command surface

- Update `test/integration/steer-view-entry.test.ts:8-23`. Instead of preserving
  `/subagents-fleet`, capture the registered names and assert the exact set is
  `['subagents']`; retain the no-UI and open behavior checks.
- Keep/expand `/subagents exit` coverage at
  `test/integration/steer-view-entry.test.ts:123-144`, and assert both
  host-editor teardown and steer-view close use the same shared exit function.
- Add a root-extension registration test (the subprocess pattern already used
  in `test/unit/index-child-registration.test.ts:21-72` is suitable) that
  captures every `registerCommand(name, ...)` call and asserts only
  `subagents`. This catches accidental reintroduction outside the
  `registerSlashCommands()` unit.
- Add a package-resource test around `package.json:44-53` that proves packaged
  prompt resources are empty/absent and that the seven `prompts/*.md`
  basenames are not returned as loaded package prompts. If recipe files remain
  in the tarball, cover the package-filter convention fallback and require an
  explicit empty prompt manifest entry.

### 5.2 Delete or relocate tests for removed command adapters

- `test/integration/slash-commands-utilities.test.ts:17-340` primarily tests
  model/cost/profile/doctor/fleet slash adapters. Once registrations are
  removed, retain the underlying tool/profile behavior in tool/domain tests,
  not through missing commands.
- `test/integration/slash-commands-saved-chain.test.ts:23-81` already expects
  `/chain` even though current source does not register it; later cases also
  dereference `/run-chain`. This suite is stale/baseline-fragile and should be
  removed or rewritten around direct tool parsing/execution rather than kept
  as command coverage.
- `test/unit/prompt-workflows.test.ts:70-133` directly pins
  `/prompt-workflow` and `/chain-prompts`. Preserve prompt discovery/parser
  tests only if that non-command functionality remains useful; remove command
  registration/execution cases.

### 5.3 Exit-action routing matrix

Add a focused unit suite (for example `subagent-exit-route.test.ts`) or extend
the steer runtime tests with an injected isolated `KeybindingsManager`:

1. active child + empty editor + default `app.exit`/Ctrl+D closes and consumes;
2. remapped `app.exit` closes and consumes;
3. old Ctrl+D after remap passes through;
4. multiple configured exit keys all work;
5. `app.exit: []` disables interception;
6. legacy `exit` configuration migrates when using the host manager path;
7. non-empty editor passes through, preserving delete-char-forward;
8. inactive child passes through;
9. close behavior (widget/status/channel/target teardown) matches
   `/subagents exit`;
10. action conflict ordering matches main `CustomEditor` priority.

Reverse the current explicit assertion that Ctrl+D is untouched
(`test/unit/child-key-route.test.ts:222-228`) if exit is folded into that
router, or leave that router focused on child actions and test a new
higher-priority exit route separately.

If package-only support for slash quit is selected, add separate cases for
configured submit key + editor text `/quit` and requested legacy `/exit`.
If the acceptance criterion includes the host's double-Ctrl+C exit, add its
500 ms state-machine cases too; otherwise document it as an upstream-hook gap.

### 5.4 Picker shortcut and config

- Remove or replace `test/unit/steer-view-entry.test.ts:25-41`, which currently
  pins hard-coded Down consumption and all of its gates.
- Remove/update `test/unit/tui-config.test.ts:8-22`, which currently pins Down
  enabled by default and persistence of `tui.openSubagentsOnDown`.
- For either picker keybinding design, add:
  - no binding means Down and all other keys pass through;
  - configured binding opens only with empty editor, no package modal, and an
    active target (if those existing gates remain product requirements);
  - remapping removes the old key;
  - `[]` removes all keys;
  - multiple keys work;
  - reload updates behavior;
  - inactive target or non-empty editor does not consume;
  - leader/custom manager behavior is covered if design A is chosen, or its
    deliberate limitation is pinned/documented for design B.

## 6. Planning implications / recommended boundaries

1. Treat explicit commands and packaged prompts as one command-surface
   requirement. The strongest regression test asserts both the exact
   extension command set and absence of packaged slash prompts.
2. Centralize the `/subagents exit` teardown and call it from command and key
   paths; do not duplicate close behavior.
3. For custom exit bindings, use the live global manager's canonical
   `app.exit` semantics, including the empty-editor check. Never hard-code
   Ctrl+D.
4. Resolve the runtime mismatch explicitly: Pi 0.83.0 has `/quit`, not
   `/exit`, and exposes no cancellable shared exit event. Full “any normal exit
   path” parity needs a host API change; a package-only implementation must
   enumerate the additional special cases it chooses to mirror.
5. Resolve the picker action contract before implementation. Unknown
   `keybindings.json` IDs are ignored and `registerShortcut()` is not
   remappable, so “no default but user-configurable in keybindings.json”
   requires either a host-defined no-default action or a consciously
   package-owned parser.

