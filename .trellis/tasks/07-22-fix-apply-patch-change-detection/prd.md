# 修复 apply_patch 变更漏记

## Goal

确保 subagent 使用 `apply_patch` 修改文件时，执行运行时将其识别为写操作，不再错误报告“没有任何更改”或触发实现任务的 completion guard。

## Background

- 前台执行和后台执行都通过共享的 `isMutatingTool()` 判断工具调用是否尝试修改文件。
- completion guard 另有一份重复的工具判断逻辑，只识别 `edit`、`write` 和变更型 `bash`。
- `apply_patch` 当前不在共享判断中，因此成功的 patch 调用不会设置 mutation-attempt 标记；实现任务随后可能被判定为没有编辑。

## Requirements

1. 将 `apply_patch` 作为变更工具纳入共享的 mutation 判断。
2. completion guard 应复用共享判断，避免前台消息扫描与前后台事件流对工具分类不一致。
3. 保持现有 `edit`、`write`、变更型 `bash`、只读工具和 MCP 工具的既有行为。
4. 增加回归测试，证明实现任务包含 `apply_patch` 调用时不会触发“未编辑”判定。

## Acceptance Criteria

- [x] `apply_patch` 工具事件在前台和后台共用的 mutation 判断中返回 true。
- [x] `hasMutationToolCall()` 能识别 `apply_patch` assistant tool call；实现任务不会因仅使用该工具而触发 completion guard。
- [x] 既有 completion guard 测试和完整 unit test suite 通过。
- [x] LSP diagnostics 无新增错误或警告。
- [x] 变更范围仅涉及共享工具分类、completion guard 复用及其回归测试，除任务记录外不改变不相关行为。

## Out Of Scope

- 不修改 `apply_patch` 工具本身、Pi host 的工具实现或 patch 语法。
- 不把所有未知 MCP 工具自动视为变更工具；未知工具仍按现有保守策略处理。
