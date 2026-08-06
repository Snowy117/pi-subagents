# Implement: long-transcript TUI responsiveness

Task: `08-05-optimize-tui-performance`

Read `prd.md`, `design.md`, and
`research/long-transcript-complexity.md` before editing.

## Ordered checklist

1. **Lock in the settings regression with deterministic tests**
   - Update `test/unit/child-conversation-assembler.test.ts` so applying an
     equal settings snapshot causes no historical native-component setter calls
     and no container invalidation.
   - Add focused cases for expansion, output padding, thinking visibility/label,
     image visibility/width, and `codeBlockIndent` behavior.
   - Prefer spies/counters over elapsed-time assertions.

2. **Make child settings application change-driven**
   - Add primitive field comparison in the child assembler settings boundary.
   - Return before walking children for an equal effective snapshot.
   - On a real change, invoke only the native setters affected by changed fields.
   - Remove unconditional whole-container invalidation.
   - Preserve correct behavior for newly appended/streaming components and the
     rare `codeBlockIndent` transition.
   - Run the child-conversation, host-editor, and steer-view unit suites.

3. **Remove transcript scans from foreground running updates**
   - Add/extend a foreground execution unit test that instruments output
     extraction or uses a long synthetic transcript.
   - Build ordinary partial-update content from bounded progress state or a
     constant placeholder; preserve existing terminal timeout/budget output.
   - Keep finalization output and message contracts unchanged.
   - Run foreground execution and compaction-related unit/integration tests.

4. **Stop quiet-run periodic root invalidation**
   - Add deterministic interval/invalidation-count coverage around subagent
     result rendering.
   - Prefer removing the 200 ms decorative timer and deriving glyph changes from
     real progress events. If a timer must remain, justify and tightly bound it
     in code and tests.
   - Verify cleanup/terminal transitions and foreground result rendering.

5. **Performance and behavioral verification**
   - Re-run the long-transcript benchmark shape from the research artifact and
     record before/after results in that artifact or implementation notes.
   - Verify equal settings cause zero old-message rebuilds at 1,000 messages.
   - Exercise collapsed/expanded child output, streaming, scrolling, settings
     toggles, completion, and control notices through tests.

6. **Full quality gate**
   - `npm test`
   - `npm run test:integration`
   - `lsp_diagnostics` for the workspace
   - Review all changes against `.trellis/spec/typescript/index.md` and
     `.trellis/spec/typescript/quality-guidelines.md`.

## Review gates

- After step 2: equal settings are O(1) before cached render and every real
  setting transition remains covered.
- After step 3: no ordinary running event performs O(transcript) extraction;
  final output is byte-for-byte compatible in tests.
- After step 4: a quiet foreground run produces no sustained decorative render
  loop, or any retained loop has an explicit measured justification.

## Rollback points

- Settings propagation, running-update extraction, and animation changes are
  separate commits/files and can be reverted independently.
- If a native component cannot safely receive selective updates, keep a
  component-specific rebuild for the changed field; do not restore unchanged
  full-history invalidation.
- Do not fall through to viewport virtualization in this task without returning
  to planning and revising the design.
