# Implement: TUI 内交互式 steer subagent

> 依据 `prd.md`（R1-R5）与 `design.md`（§1-§8）。按序执行；每步完成后跑对应验证。

## 验证命令

- 单元测试：`npm run test:unit`
- 集成测试：`npm run test:integration`
- E2E：`npm run test:e2e`（真实 session，改动 child 协议后必跑）
- 全量：`npm run test:all`

（仓库无 lint/typecheck script；类型安全靠 spec 的 schema-and-type-safety 准则与测试。）

## 步骤

### Phase 0 — Pi 0.82.1 依赖升级（独立基线）

- [x] 0.1. 将直接依赖 `@earendil-works/pi-tui` 与 devDependencies `pi-agent-core` / `pi-ai` / `pi-coding-agent` 统一升级到 `0.82.1`，更新 `package-lock.json`；peerDependencies 保持 `*`。
- [x] 0.2. 检查 0.74→0.82 类型/API 变化，更新 `src/shared/model-info.ts` 与相关测试以匹配 0.82 thinking/model compatibility；修复仅由升级触发的兼容问题，不引入新功能。
- [x] 0.3. 运行 `npm run test:all`，建立 0.82 干净基线。

**回滚点 0**：若基线不能独立全绿，回滚 package/lock 与兼容修复，暂停后续 Phase A/B，避免把升级故障与新功能混合。

### Phase A — 运行时接线（无 UI，可独立验证）

- [ ] A1. 通用 action 协议：新建 `src/runs/shared/control-actions/{actions,paths,channel}.ts`；独立 `action-targets/<index>/{requests,responses}`，versioned request/response、严格校验、原子写入、claim/consume、过期清理、可注入 fs/clock/id。
- [ ] A2. child 侧消费：新增独立 `registerControlActionInbox`，不修改 steer parser 语义；`cycleThinking` 根据 0.82 模型 metadata 选下一可用等级，`pi.setThinkingLevel` 后读取实际等级；所有请求产生 applied/rejected response，未知 action 安全拒绝。
- [ ] A3. foreground live control registry：新增 deterministic `FOREGROUND_RUNS_DIR` 与 `state.foregroundLiveChildren`；在 `run-single-attempt.ts` spawn 前注册每个 child 并通过 `buildPiArgs` 传 steer/action dirs；记录 agent/index/status/transcriptPath/controlRoot，child/run/session 结束按规则清理。
- [ ] A4. 解除 `action-dispatch.ts` 对 foreground steer 的拒绝并直写 child steer inbox；async/foreground action 均直写目标 step action request inbox，queued/pending async 请求等待 child spawn 后消费（无 runner 二次路由）。
- [ ] A5. 可选审计记录：action response 可写 transcript/control notice，但 request/response outbox 才是回执权威。
- [ ] A6. 测试：action 协议 parse/atomic/claim/dedupe/rejected/cleanup；foreground parallel live registry 与 steer；cycleThinking applied/rejected；async queued/running direct-inbox 回归。
  - 验证：`npm run test:unit && npm run test:integration`

**回滚点 A**：A1-A5 是独立可交付切片（tool action 层已能 steer foreground），出问题 `git checkout` 本切片文件即可，不影响现有功能。

### Phase B — 视图组件（TUI）

- [ ] B1. 所有 active child 的 live transcript：持久 artifact 开启时复用原路径，否则创建 scoped 临时 runtime path；async status/foreground live registry 暴露路径；实现 view 引用与 terminal/session cleanup。再实现 `transcript-tail.ts` 的 byte-offset、truncated、fallback 与 trusted-root 校验。
- [ ] B2. 铺满终端的 capturing overlay `steer-view-component.ts`：状态行 + Markdown 对话区 + Input；250ms transcript/status/action-response 刷新；滚动；slash 先关闭 overlay 后预填；shift+tab 发 action 并显示 applied/rejected；Enter 发 steer + 送达确认；Esc 返回 picker。
- [ ] B3. picker `run-picker.ts`：SelectList overlay，合并 `state.asyncJobs` + `listAsyncRuns()` + `state.foregroundLiveChildren` + remembered `foregroundRuns` fallback，生成 step 粒度条目。
- [ ] B4. 入口：`/subagents` slash 命令；`ctx.ui.onTerminalInput`（Down 仅空编辑器/有 run/无本扩展 modal 时 consume，其余返回 undefined）；新增 typed `TuiConfig`/`ExtensionConfig.tui` 与 normalization/read-write；测试 CustomEditor 共存、监听器竞争 fallback、配置默认/覆盖。
- [ ] B5. 清理纪律：dispose 停 interval；资源挂 `__piSubagentRuntimeCleanup`；stale ctx 捕获。
- [ ] B6. 测试：transcript-tail 单元测试（offset/截断/fallback）；组件键位单测（照 chain-clarify 测试先例 `test/integration/chain-clarify.test.ts`）；配置项单测。
  - 验证：`npm run test:unit && npm run test:integration`

**回滚点 B**：UI 层整体可摘除（删命令注册 + terminal-input handler），Phase A 运行接线独立成立。

### Phase C — 端到端与收尾

- [ ] C1. 手工 e2e：真实 pi session 中跑 parallel async runs + 一个 foreground run，并覆盖 transcript artifact 关闭配置，验证 AC1-AC9 全项。
- [ ] C2. `npm run test:all` 全绿。
- [ ] C3. 文档：README 或 SKILL.md 补一段「交互式 steer 视图」用法（入口、键位表）。

## 审查门禁

- Phase A 完成后：跑 trellis-check（重点：cross-extension-contracts——信封 schema 变更；error-and-io-guidelines——信箱 IO 容错）。
- Phase B 完成后：trellis-check 全量（最后一轮 2.2 必须 full-scope）。
- 全部完成后：trellis-update-spec（控制协议、terminal-input/overlay 模式等新知识）→ 提交。

## 风险文件

- `src/runs/shared/subagent-prompt-runtime/runtime-registration.ts`（child 侧，所有 spawn 模式共用，改动影响面最大——回归 `test/integration/single-execution-*.test.ts`、`async-execution-*.test.ts`）
- `src/runs/foreground/execution/run-single-attempt.ts`（foreground spawn 与 live-control env 核心路径）
- `src/runs/foreground/executor/action-dispatch.ts`（解除 foreground steer 拒绝）
