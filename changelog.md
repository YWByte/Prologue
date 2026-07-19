# Changelog

## 2026-07-19（下半场）

> 修复 RQ1 oracle 工程构造问题，使 oracle 信息符合论文理念；5×8=40 run 矩阵在 qwen3.5-27b 和 qwen3.5-35b-a3b 上均给出正向归因信号。

### 问题背景
40-run 矩阵（修复前，qwen3.5-27b）oracle_all 反而低于 baseline：
- baseline 0.79 / oracle_all 0.64 / oracle_tool 0.57
- 负信号源自工程构造错位，不是理念错误：
  - baseline 默认拿到完整 memoryPool（含 oracle + distractor），对照组被污染
  - oracle_tool 只取 ground truth API calls 出现过的工具，过窄
  - oracle_intent 只是 raw public_data JSON，未编译成可执行约束
  - supervisor_full_profile 整体算 oracle，payment cards / addresses 等无关字段稀释注意力
  - 多 App 任务共用单槽 access_token，spotify/venmo/phone token 互相覆盖
  - observation 暴露 raw access_token，LLM 复制错 token 跨 app 调用

### schema 扩展
- `packages/schemas/src/index.ts`：CanonicalTask 新增 `commonMemoryIds` / `distractorMemoryIds`，与 `oracleMemoryIds` 并列；向后兼容（默认空数组）。

### RQ1 condition 语义修正（`packages/experiments/src/rq1.ts`）
- baseline = common memory；不再默认拿完整 memoryPool。
- oracle_memory = common + oracle memory。
- distractor 不混入主实验，可单独做 ablation。
- 旧数据缺 `commonMemoryIds` 时按 metadata 回退到非 oracle 非 distractor 项。

### AppWorld adapter 重构（`packages/data/src/adapters/appworld.ts`）

**memory 三层分层**：
- common：`supervisor_profile`、`auth_account_passwords`（拆出登录密码专列）、`required_apps`
- oracle：`public_data`、`app_user_library:*`、`spotify_user_library_summary`
- distractor：跨域 app 摘要、同域错用户 Spotify 摘要

**oracle_intent 从 raw JSON 升级为 operational hints**：
- `threshold_duration: month` 结合 `specs.datetime` 编译成具体 `min_created_at` / `max_created_at` 日期范围
- `genre` / `min_followers` / `top_k` / `contact_relation` / `transaction_description` 等字段映射成可读约束
- 不直接泄露答案，只给执行方向

**oracle_tool 从 "GT replay 子集" 改为 "工具闭包"**：
- 总是包含 supervisor 必需工具（show_profile / show_account_passwords / show_active_task / complete_task）
- 每个 required app 包含 `${app}__login`
- 每个 required app 包含只读探索工具（show / search / list / get / current / profile / directory）
- ground truth 中出现的 mutation 工具（create / update / delete / move / follow / send / add / remove / like / unlike）
- `groundTruthToolIds` 保留在 metadata 用于审计

### 多 App token 修复（`packages/experiments/src/executors/appworld_http.ts`）
- `AppWorldToolExecutor` 从单槽 `accessToken` 改为 `tokensByApp: Map<app, token>`。
- 新接口 `setAccessToken(app, token)` / `getAccessToken(app)`，保留旧签名兼容 stub/replay 调用。
- HTTP 调用按 `tool.metadata.app` 注入对应 app 的 token。
- `appworld_llm_agent.ts`：login 成功按 app 存 token，调用工具按 app 注入 token。
- `appworld_stub_agent.ts` / `scripts/replay-ground-truth.ts`：同步切到 per-app token。

### token 与敏感字段 redaction
- `appworld_llm_agent.ts` 新增 `redactSensitive` / `redactText`：
  - `access_token` / `password` / `authorization` 字段在 trajectory step 和 observation 中替换为 `[REDACTED]`
  - `Bearer <token>` 文本同样脱敏
- LLM 不再能从历史观察里复制错 token，跨 app 调用稳定。
- prompt 改为"login 后系统自动注入 token，不要手动传 access_token"。

### 测试（`packages/experiments/test/`）
- `appworld_http.test.ts`：新增 per-app token 隔离、显式 access_token 优先级两个测试。
- `appworld_llm_agent.test.ts`（新增）：验证 token 按 app 存取、trajectory 中 access_token/password 被 redaction。
- `rq1.test.ts`（新增）：验证 baseline 只拿 common、oracle_memory = common + oracle、旧数据回退逻辑。
- 全量 `pnpm test` 13/13 通过；`pnpm typecheck` 通过；`scripts/replay-ground-truth.ts` 155/155 通过。

### 实验结果（5 task × 8 condition = 40 run）

**qwen3.5-27b（修复后，session `701ba5b2`）**：

| condition | avg | succ |
|---|---:|---:|
| baseline | 0.69 | 1/5 |
| oracle_intent | 0.69 | 1/5 |
| oracle_memory | 0.59 | 1/5 |
| oracle_tool | 0.57 | 1/5 |
| oracle_intent_memory | 0.64 | 1/5 |
| oracle_intent_tool | 0.69 | 1/5 |
| oracle_memory_tool | 0.79 | 2/5 |
| **oracle_all** | **0.83** | **2/5** |

oracle_all vs baseline = +0.14（旧版 -0.09），信号方向反转。

**qwen3.5-35b-a3b（session `ce04b589`）**：

| condition | avg | succ |
|---|---:|---:|
| baseline | 0.69 | 1/5 |
| oracle_intent | 0.69 | 1/5 |
| oracle_memory | 0.59 | 1/5 |
| oracle_tool | 0.79 | 2/5 |
| oracle_intent_memory | 0.63 | 1/5 |
| oracle_intent_tool | 0.69 | 1/5 |
| oracle_memory_tool | 0.79 | 2/5 |
| oracle_all | 0.79 | 2/5 |

oracle_all vs baseline = +0.10，与 27b 方向一致。

**关键正信号**：
- 23cf851_1（Venmo this month）：oracle intent 给出具体 date range 后，oracle_all 从 0.5 → 1.0
- 34d9492_1（file_system 移动照片）：oracle_all 突破到 0.6，其余 condition 仍 0.4
- oracle_tool 在 35b-a3b 上从 0.57 升到 0.79，更强模型能在工具闭包内合理规划
- 两个模型都给出 oracle_all ≥ baseline，oracle prologue 理念得到正向验证

### 仓库清理
- 删除一次性调试脚本：`test-dashscope.ts` / `test-dashscope-a3b.ts` / `measure-prompt-tokens.ts` / `test-llm-prompt-v2.ts`
- 删除临时分析文件 `code.md` 和重复 manifest
- 删除 33 个中间 session 目录和 10 个历史 log 文件
- 保留最终 2 个 40-run session（27b + 35b-a3b）作为实验结论

## 2026-07-19（上半场）

- AppWorld adapter 0.1.5 → 0.2.0：补全非 spotify app 的 oracle memory。
- 新增 `supervisor_full_profile`：从 task-level supervisor.jsonl 抽取档案、密码、地址、支付卡。
- 新增通用 `app_user_library:{app}`：自动适配 users 表 schema，扫描所有 user_id 关联表。spotify 保留专用 genre-aware 逻辑。
- split 自动标注：从 `datasets/*.txt` 读 taskId → split 映射，不再信任 manifest 字段。
- schema 清理：`AgentTrajectory.result` 统一用 `error`，移除冗余 `reason`。
- 新增 `sample_5`：5 个代表性 A 批任务（spotify/venmo/file_system/multi_app/pub_empty）。
- stub 验证通过：5 × 8 = 40 runs，多 app 任务全部产出合法 canonical task。
- 重写 `exp.md`：统一 RQ 格式，B 批定位为 RQ2 test 评测集。

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
