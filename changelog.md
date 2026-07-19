# Changelog

## 2026-07-19

- AppWorld adapter 0.1.5 → 0.2.0：补全非 spotify app 的 oracle memory 抽取。
- 新增 `supervisor_full_profile` oracle memory：解析 task-level `dbs/supervisor.jsonl`，抽取 supervisor 档案、account_passwords、addresses、payment_cards。
- 新增通用 `app_user_library:{app}` oracle memory：自动检测 users 表 schema，按 email/phone 定位用户，扫描所有含 `user_id` 列的表，抽取 count + 3 条样本。
- spotify 保留专用 genre-aware 抽取逻辑，其他 app（venmo / file_system / phone / simple_note 等）走通用方案。
- 修复 split 自动标注：adapter 从 `datasets/*.txt` 读取 taskId → split 映射，不再信任 manifest 的 split 字段。
- 修复 `dataRoot` 路径识别：支持 `sample_5` 后缀。
- 删除未使用的 `SupervisorPatchRow` 类型。
- schema 清理：`AgentTrajectory.result` 移除冗余 `reason` 字段，统一用 `error`。
- `rq1.real.ts` 同步 `reason → error` 字段映射。
- 新增 `sample_5`：5 个代表性 A 批任务（spotify/venmo/file_system/multi_app_3/pub_empty）。
- 在 sample_5 跑通 stub 验证：5 × 8 = 40 runs，adapter 在多 app 任务上全部产出合法 canonical task。
- 重写 `exp.md`：每个 RQ 统一格式（作用/要证明/实验/指标/数据/预期），B 批定位为 RQ2 test 端到端评测集。

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
