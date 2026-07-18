# Changelog

## 2026-07-18

- 实现 RQ1 真实 executor:驱动 AppWorld REST API server → 持久化 DB 改动 → 调官方 `evaluate_task`。
- 新增 `Executor` / `ToolExecutor` 接口于 `@prologue/prologue`,与 IntentClarifier/MemoryGater/ToolSelector/SufficiencyVerifier 同层。
- 新增 AppWorld executor 模块:`appworld_http`(OpenAPI→fetch)、`appworld_stub_agent`(固定序列 + 答案推导)、`appworld_server`(per-condition 起停 `serve apis`)、`appworld_python`(subprocess 调 `evaluate_task` / `init_task`)、`appworld`(组合)。
- 新增 Python 脚本 `python/appworld/{serve_apis, eval_task, init_task}.py`,薄包装官方 AppWorld 接口。
- stub agent 第一版未接真实 LLM:看 `usesOracleMemory` flag,从 oracle memory 推答案;flag=false 交空答案。这是受控实验设计,不是真实 agent 行为。
- CLI 加 `rq1:run` 命令;路径相对 `INIT_CWD` 解析,避免 pnpm filter 下相对路径失效。
- `AgentTrajectory.result` 加 optional `reason` 字段,对齐 `EvalResult`。
- 修复 AppWorld `initialize()` 在 fresh process 的 time_freezer 报错:手动调子步骤跳过 `close_all()`。
- 修复 `AppWorldToolExecutor` URL 重复 app 前缀:OpenAPI path 已含 app 名,直接 `baseUrl + path`。
- 修复 AppWorld evaluator 拒绝路径含 "memory" 子串(误判为 in-memory 连接串):experiment_name 内 `memory→mem` 转义,trajectory metadata 保留原始 condition 名。
- 在 2-task AppWorld sample 跑通 RQ1 真实闭环:16 条 trajectory,8/16 成功。
- 归因矩阵符合预期:4 个 oracle_memory condition 全成功,4 个非 oracle_memory condition 全失败 → memory 是可恢复失败源。tool/intent 单独无恢复效果(stub 不依赖 tool,推答案靠 memory)。
- mock regression 不变:仍 4/16(mock 政策要求 memory AND tool)。

## 2026-07-15

- 初始化 pnpm monorepo：`schemas`、`data`、`log`、`session`、`common`、`prologue`、`experiments`、`cli`。
- 配置 TypeScript build/typecheck，完成 workspace 自检。
- 定义核心 schema：`CanonicalTask`、`MemoryItem`、`ToolItem`、`EvaluatorSpec`、`DatasetManifest`、`VerifierExample`、`LogEvent`、`SessionFile`、`AgentTrajectory`。
- 生成 schema 示例数据：canonical task、verifier example、manifest、log、session。
- 下载 AppWorld 数据，创建 `dev` split 最小样本：`50e1ac9_1`、`50e1ac9_2`。
- 实现 `AppWorldAdapter`，转换 AppWorld sample 为 `CanonicalTask`。
- 收紧 AppWorld memory 规则：移除 evaluator/test/metadata 泄漏，保留执行前可见上下文。
- 从 `base_dbs/spotify.db` 抽取当前用户 Spotify 库摘要。
- 展开 Spotify song / album / playlist library 摘要。
- 加入 memory distractor：同域错用户 Spotify 摘要、跨域 app state 摘要。
- 生成 `data/canonical/appworld-sample.jsonl` 和 `appworld-sample-manifest.json`。
- 初始化 Prologue git 仓库。
- 实现 RQ1 八种 oracle condition 与 mock runner；原始 query 在全部条件中保留。
- 使用 AppWorld sample 跑通 RQ1 mock 闭环：2 个任务、16 条 trajectory。
