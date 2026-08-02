# Unify child mode to persistent RPC, fix always-read-only bug

## Goal

消除 JSON/RPC 双模式带来的复杂性和"总是 read-only" bug。所有子代理一律使用 `--mode rpc`（持久常驻进程），不再支持 `--mode json -p` 一次性模式。这样 `resolveChildChannel` 总能找到常驻进程或 session 文件，用户永远进入 host-editor 聊天模式而非只读视图。

## Background / Confirmed Facts

- `foregroundLiveChildren` 条目缺少 `sessionFile` 字段：当子代理进程退出后（JSON 模式或异常退出），`getForegroundResident` 返回 undefined 且 target 无 `sessionFile` → `resolveChildChannel` 返回 undefined → 用户看到只读视图。
- 即使 RPC 模式（默认启用），`foregroundLiveChildren` 不携带 `sessionFile` 也是隐患——如果进程意外退出，没有回退路径。
- 代码中大量 `if (persistent)` / `if (persistent && registry)` 分支增加了维护成本。
- 用户配置中 `persistentChildren` 默认即 `{ enabled: true }`，JSON 模式仅用于测试（`PI_SUBAGENT_E2E_JSON_CHILD`）。

## Requirements

### R1 统一 RPC 模式
- 移除 `persistentChildren` 配置开关，子代理永远以 `--mode rpc` 启动。
- `src/runs/foreground/execution/run-single-attempt.ts` 中 `persistent` 分支变成唯一路径，移除 `if (persistent)` 条件判断。
- `src/runs/background/runner/run-pi-streaming.ts` 中类似的条件清理。
- 保留 `PI_SUBAGENT_E2E_JSON_CHILD` 环境变量用于测试（选择退出 RPC 模式）。

### R2 foregroundLiveChildren 携带 sessionFile
- `ForegroundLiveChild` 接口添加 `sessionFile?: string` 字段。
- `registerForegroundLiveChild` 调用处传入 `sessionFile`（来自 `options.sessionFile`）。
- `fromForeground` 在 `foregroundLiveChildren` 分支中透传 `sessionFile`。
- `resolveChildChannel` 的 `resolveForeground` 路径中，当 resident 不存在时优先用 `sessionFile` 重开。

### R3 清理配置
- `config.ts` 移除 `persistentChildren` / `ResolvedPersistentChildConfig` / `resolvePersistentChildConfig`（或简化为 always-on）。
- 移除 `evictionTimer` 中对 `config.persistentChildren.enabled` 的判断（始终启用淘汰）。
- 移除 `extension/index.ts` 中 `config.persistentChildren` 的默认值注入逻辑。

### R4 回归
- 现有测试套件全绿（`PI_SUBAGENT_E2E_JSON_CHILD=1` 保留 JSON 模式测试路径）。
- 手动 smoke：foreground 子代理 → `/subagents` 选中 → 进入 host-editor 模式（非只读）。

## Acceptance Criteria

- [ ] AC-1 统一 RPC：`run-single-attempt.ts` 中 `persistent` 恒为 `true`，`if (persistent)` 分支移除，`--mode rpc` 是唯一启动方式。
- [ ] AC-2 sessionFile 注入：`ForegroundLiveChild` 有 `sessionFile` 字段，`foregroundLiveChildren` 构建的 target 包含 `sessionFile`。
- [ ] AC-3 resolver 修复：`resolveChildChannel` 对 foreground target 的 `resolveForeground` 路径中，resident 不存在时能用 `sessionFile` 重开会话。
- [ ] AC-4 配置清理：`persistentChildren` 配置移除或默认 always-on。
- [ ] AC-5 回归：`npm run test:unit` 全绿；`PI_SUBAGENT_E2E_JSON_CHILD=1` 下的 JSON 模式测试路径保留。
- [ ] AC-6 smoke：foreground 子代理完成后 `/subagents` 选中 → host-editor 模式（非只读）。

## Out of Scope

- 重构 async runner 的 RPC 生命周期（现有 async bridge 已用 RPC 模式，不受影响）。
- 为 `--no-session` 子代理提供 RPC 模式下的会话延续（需上游支持）。

## Open Questions

- 无阻塞。