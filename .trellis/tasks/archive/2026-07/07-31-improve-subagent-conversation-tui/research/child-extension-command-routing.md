# Child extension command routing

## Concrete case: `//dcp`

The desired example is: while a selected-child conversation mode is active,
enter `//dcp` in the real host editor and open the **selected child's** DCP
command view, not the parent's DCP state and not a literal LLM prompt.

That does not work through the existing steer route:

- `registerSteeringInbox()` calls `pi.sendUserMessage(message,
  { deliverAs: "steer" })` in
  `src/runs/shared/subagent-prompt-runtime/runtime-registration.ts`.
- Pi's `AgentSession.sendUserMessage()` calls `prompt()` with
  `expandPromptTemplates: false` and `source: "extension"`; the source comment
  explicitly says command handling and template expansion are skipped
  (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1098-1131`).
- Therefore sending `/dcp` as steer produces a user message for the child model;
  it does not invoke the registered extension command.

The installed DCP implementation also demonstrates why command invocation alone
would be insufficient:

- DCP registers `dcp` and `dcp-compress` through `pi.registerCommand()` at
  `../pi-dcp-migrate/commands.ts:17-95`.
- `/dcp`, `stats`, and `context` report through `execCtx.ui.notify()`
  (`commands.ts:25-78,97-103`).
- A subagent process runs headlessly with `--mode json -p`
  (`src/runs/foreground/execution/run-single-attempt.ts` and
  `src/runs/background/runner/run-single-step-helpers.ts`). Its UI notification
  is not a parent-TUI panel and there is no public cross-process component
  transport.
- Pi exposes command registration and command metadata, but no public extension
  API for one extension to execute another extension's registered command and
  capture its UI operations as a serializable result.

## Consequence

`//name` cannot truthfully mean “execute any child slash command” using only the
current Pi and steer APIs. It needs an explicit remote-extension-action
contract. Arbitrary `registerCommand()` handlers may switch sessions, open
custom TUI components, access command-only context, or perform other
non-serializable operations; invoking them by reflection would be unsafe.

## Recommended opt-in protocol

Add a versioned, opt-in remote child action API owned by pi-subagents. A child
extension registers a serializable action rather than relying on interception of
`pi.registerCommand()`:

```ts
type RemoteChildActionDefinition = {
  name: string;
  describe?: () => { description: string; argumentHint?: string };
  execute(args: string, context: RemoteChildActionContext):
    Promise<RemoteChildActionResult> | RemoteChildActionResult;
};

type RemoteChildActionResult =
  | { kind: "notice"; title?: string; text: string; level?: "info" | "warning" | "error" }
  | { kind: "document"; title: string; markdown: string }
  | { kind: "form"; title: string; fields: SerializableField[] }
  | { kind: "error"; message: string };
```

Data flow:

```text
host editor `//dcp stats`
  -> parent child-mode input handler consumes submission
  -> versioned request written to selected child's action inbox
  -> child pi-subagents runtime dispatches registered remote action `dcp`
  -> DCP reads that child's own state and returns a serializable result
  -> child response outbox
  -> parent viewer renders the result with parent TUI components
```

Registration should use a load-order-safe consumer API (for example a
`Symbol.for(...)` registry with a pending queue, similar to pi-tool-display's
consumer API), because DCP and the child control runtime are separate
extensions. Only explicitly registered actions are callable.

For DCP, refactor command logic so the existing parent `/dcp` adapter and the new
remote action adapter share pure result builders. The parent command can keep
using `ui.notify`; the child remote adapter returns the same information as
serializable content. Mutating subcommands such as `manual on|off` and
`compress` need explicit inclusion and response semantics.

## Limitations and fallback

- This does not make arbitrary third-party slash commands remotely executable.
- Arbitrary child custom components cannot be moved between processes. Remote
  panels must be represented by an agreed serializable view model and rendered
  in the parent.
- When a `//name` provider is absent from the selected child, the viewer should
  report “child action not available” and must not send the text to the LLM
  silently.
- A separate escape such as `///text` can be reserved for sending literal text
  beginning with `/` to the child model if that capability is desired.
- Child extension loading is configurable. `agent.extensions: []` causes Pi to
  launch with `--no-extensions` plus only explicitly selected/runtime
  extensions, so DCP may legitimately be unavailable for a particular child.

## Scope implication

Making `//dcp` work requires coordinated changes in pi-subagents and
`../pi-dcp-migrate`, or an upstream Pi API that provides an equivalent safe
remote-command/view contract. It is independently verifiable and should be a
separate implementation slice even if retained in the same Trellis task.

