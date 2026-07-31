# Transcript 访问（读取 child 对话记录）

> 研究问题：action "status", view "transcript" 如何读 child 对话？child session/transcript 文件在哪？src/shared/child-transcript.ts 是什么？能否 tail 一个活着的 child 实现实时滚动视图？

## 核心结论（TL;DR）

存在**三个互补的对话记录源**，TUI 实时视图应首选 **child transcript JSONL**（结构化、增量友好）：

| 源 | 路径 | 内容 | 实时性 | 结构化 |
|---|---|---|---|---|
| **child transcript JSONL** | `<artifactsDir>/<run>_<agent>[_<idx>]_transcript.jsonl` | message/tool_start/tool_end/stdout/stderr 记录 | **live 追加**（每事件 append） | ✅ JSONL，带 ts/role/text |
| child stdout log | `<asyncDir>/output-<N>.log` | child pi 进程 stdout 原始事件流 | live | 半结构化（JSONL 事件 + 非 JSON 行） |
| pi session 文件 | `<sessionDir>/*.jsonl`（status.json 的 `steps[].sessionFile`） | pi 原生 session 记录 | live（pi 内部写） | JSONL，需按 `message.role` 解析 |

## 1. src/shared/child-transcript.ts 是什么

`createChildTranscriptWriter(input)`（`src/shared/child-transcript.ts:76`）— **父进程侧的结构化对话记录器**。输入 `{ transcriptPath, source: "foreground"|"async", runId, agent, childIndex?, cwd, maxBytes? }`（默认上限 50MB，超限写 truncated marker）。

写入 API（工厂返回对象的方法）：`writeInitialUserMessage(prompt)`（run 开始时的任务）；`writeChildEvent(event)`（解析 child stdout 的 JSON 事件：`message_end`/`tool_result_end` → 完整 message 记录（含 role/text/model/usage/stopReason），`tool_execution_start` → tool_start（含 argsPreview），`tool_execution_end` → tool_end）；`writeStdoutLine` / `writeStderrLine` / `writeStderrText`（非 JSON 输出）。

每条记录是单行 JSON：`{ version: 1, recordType, source, runId, agent, childIndex?, cwd, ts, timestamp, role?, text?, toolName?, argsPreview?, message? }`。**append-only、`appendFileSync` 逐条写——天然适合 tail -f 式增量读取。**

### 谁在用
- async：`src/runs/background/runner/run-single-step.ts:80`（`artifactConfig.includeTranscript !== false` 时创建），事件在 runner 解析 child stdout 时写入
- foreground：`src/runs/foreground/execution/single-attempt-events.ts:60-64` — 父 extension 进程逐行解析 child stdout 时同步 `transcriptWriter?.writeChildEvent(evt)` / `writeStdoutLine(line)`。**foreground run 的 transcript 在父进程内实时落盘**
- 路径生成：`getArtifactPaths(artifactsDir, runId, agent, index)`（`src/shared/artifacts.ts:29`），`transcriptPath = <artifactsDir>/<base>_transcript.jsonl`（:37）；async 步级路径 `resolveAsyncStepTranscriptPath`（`src/runs/background/runner/parallel-helpers.ts:117`）
- 结果回传：`SingleResult.transcriptPath` 记入 `state.foregroundRuns`（foreground-state.ts:134）与 status.json 的 `steps[].transcriptPath`（runner-step-sequential.ts:80 等），所以**已知 run → 已知 transcript 路径，无需猜**

## 2. action "status", view "transcript" 的现状实现

入口：`src/runs/background/run-status/status.ts:44` `inspectSubagentStatus(params, deps)`；`view: "transcript"` 分支（:68、:100、:113、:163、:259）按 run 类型分派：

- foreground remembered → `formatRememberedForegroundTranscript`（`run-status/format-helpers.ts`）
- nested → `formatNestedRunTranscript`（`fleet-view/transcript.ts:147`）
- async → `formatAsyncRunTranscript(status, asyncDir, { index?, lines?, sessionRoots? })`（transcript.ts:94）

`formatAsyncRunTranscript` 的回退链（transcript.ts:108-133）：
1. `output-<index>.log`（或 run 级 outputFile）经 `readContainedTextTail` 取 tail
2. status.json 的 `step.recentOutput`
3. `step.sessionFile` 经 `readSessionTranscriptTail` 解析 tail

注意：**现有 transcript 视图没有用 child-transcript JSONL**，它面向 output log / session 文件。`_transcript.jsonl` 目前主要作为 artifact 落盘 + `transcriptPath` 元数据存在——这对新功能是好消息：结构化源已就绪但尚无消费者，TUI 可以成为第一个。

### 底层读取原语
`src/runs/background/fleet-view/transcript-tail.ts`：
- `readContainedTextTail(filePath, maxLines, trustedRoots, label)`（:67）— 从尾部最多读 256KB（`TRANSCRIPT_TAIL_BYTES`，:7），拒绝越出 trusted roots、拒绝 symlink、realpath 校验。**安全模型现成的，TUI 复用即可**（asyncDir 是天然 trusted root）
- `readSessionTranscriptTail(sessionFile, maxLines, trustedRoots)`（:133）— 解析 pi session JSONL，提取 `role: text` 行
- `transcriptLineLimit`（:15）— 默认 80 行、上限 500

## 3. child 的 session 文件在哪

- async：`status.json` 的 `sessionFile` / `steps[].sessionFile`（`AsyncStatus`），由 runner 从 child 结果收集；session 根目录 `getSubagentSessionRoot(parentSessionFile)`（`src/extension/registration/session-paths.ts`）
- foreground：`SingleResult.sessionFile` → `state.foregroundRuns[runId].children[i].sessionFile`
- resume 校验要求 `.jsonl` 后缀（async-resume/resume.ts:84 `validateResumeSessionFile`）

## 4. 能否增量 tail 活着的 child？

**能，三种方式按推荐度排序：**

1. **tail `_transcript.jsonl`**：记录粒度正是 TUI 需要的（role+text+tool 事件+ts），`appendFileSync` 写入原子性够逐行追加。实现：记 byte offset，定时/watch 读取增量，按行 JSON.parse。已有类似先例——tracker 的 `emitNewControlEvents`（`async-job-tracker/helpers.ts`）用 `controlEventCursor` 增量扫 `events.jsonl`，模式可直接照搬
2. **tail `output-<N>.log`**：原始事件流，信息最全（含 message_update 流式增量——如果想做打字机效果），但要重新实现 child stdout 协议解析
3. **tail session `.jsonl`**：pi 原生格式，`readSessionTranscriptTail` 已有解析器（`sessionMessageLine`），但记录时机由 pi 内部决定（通常 message 完成才落盘），且 trusted roots 需配置（`trustedSessionRootsForStatus`，foreground-state.ts:64）

刷新触发：`fs.watch`（watchAsyncControlInbox 已证明在该 tmp 目录上可靠 + 250ms 轮询兜底模式可复用）或直接挂进 async-job-tracker 的 250ms poller。

**限制**：`output-<N>.log` / `_transcript.jsonl` 是 runner/父进程写的；child 崩溃后文件停止增长但 run 状态需经 `reconcileAsyncRun` 才更新——TUI 视图要同时盯 status.json 的 `state`/`steps[].status` 来显示"已结束/失败"。

## 对本功能的启示

1. **实时滚动视图首选 tail child-transcript JSONL**：结构化、带时间戳、逐条 append、路径可从 `state.asyncJobs`/status.json/`foregroundRuns` 直接获得。增量读取实现约等于"offset + readline + JSON.parse"。
2. **fallback 链照抄 `formatAsyncRunTranscript`**：transcript 不存在（`includeTranscript: false` 或老 run）时回退 output log → recentOutput → session file，`readContainedTextTail` 的安全校验直接复用。
3. **foreground 与 async 的 transcript 路径都已持久化在已知位置**（foregroundRuns/async status.json），TUI 不需要文件系统探测。
4. **steer 确认闭环**：TUI 发完 steer 后可 watch transcript 中出现对应 user 消息作为"已送达"信号（child 消费 inbox → sendUserMessage → message_end 事件 → transcript 落盘），弥补 steer 通道无回执的缺口。
5. 50MB 截断 marker 要在解析时容错（recordType === "truncated"）。
