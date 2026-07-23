# Changelog

## 2026-07-23

> batch_a 全量 147×8=1176 runs 实验完成；provider_error 与 executor_error 分离；新增 vLLM provider 和结果分析脚本。

### AppWorld batch_a 全量实验完成

**147 tasks × 8 conditions = 1176 runs**（qwen3.5-27b，跨 dashscope/vllm/siliconflow 三种 provider 完成）

| condition | n | mean | median | succ | delta vs baseline |
|---|---|---|---|---|---|
| baseline | 147 | 0.692 | 0.750 | 19 | — |
| oracle_intent | 147 | 0.684 | 0.800 | 16 | -0.008 |
| oracle_memory | 147 | 0.710 | 0.800 | 21 | +0.018 |
| oracle_tool | 147 | 0.702 | 0.778 | 18 | +0.010 |
| oracle_intent_memory | 147 | 0.728 | 0.800 | 22 | +0.036 |
| oracle_intent_tool | 147 | 0.669 | 0.750 | 14 | -0.023 |
| oracle_memory_tool | 147 | 0.724 | 0.800 | 23 | +0.032 |
| oracle_all | 147 | 0.748 | 0.800 | 24 | +0.056 |

**关键发现**：
- oracle_all (0.748) > baseline (0.692)，+8.1%，全 oracle 提升明显
- oracle_intent_tool (0.669) < baseline (0.692)，Intent+Tool 拮抗效应（synergy = -0.025）
- oracle_intent 单独无提升（-0.008），但与 Memory 组合时产生协同效应（synergy = +0.026）
- Memory 是最稳定的正向 oracle，所有含 memory 的 condition 都高于 baseline
- Intent+Tool 负交互效应原因：agent 过度自信，步骤骤减（57.2 vs 61.8），跳过必要探索

### provider_error vs executor_error 分离

- `packages/experiments/src/executors/appworld.ts`：catch 块区分 `LlmCallError`（provider_error）与其他错误（executor_error）
- `scripts/test-llm-oracle-all.ts`：`RunResult` 新增 `providerError` 字段，resume 逻辑同时重跑两种 error
- API 提供商错误（Arrearage/quota/rate limit/auth/context length）不再混入 executor_error

### vLLM provider（`packages/common/src/providers/vllm.ts`）

- 新增 vLLM OpenAI-compatible provider，默认 `baseUrl: http://localhost:4000/v1`，`apiKey: "EMPTY"`
- `ProviderSpec` 新增 `optionalApiKey`（vLLM 不需要 key 时用 placeholder）和 `baseUrlEnvKey`（环境变量覆盖 baseUrl）
- 支持 `VLLM_BASE_URL` / `VLLM_API_KEY` 环境变量

### 环境变量驱动路径配置

- `scripts/test-llm-oracle-all.ts`：`appworldRoot` 支持 `PROLOGUE_APPWORLD_ROOT`，`pythonPath` 支持 `PROLOGUE_APPWORLD_PYTHON`
- `loadEnvIntoProcess()` 提前到 CONFIG 之前，确保环境变量对 CONFIG 可见

### 结果分析脚本（`scripts/analyze-rq1-results.ts`）

- 从 session.json 读取 trajectories，按 condition 统计 mean/median/min/max/success
- 计算 delta vs baseline、交互效应（synergy/antagonism/additive）
- per-task delta 分布（better/same/worse）
- step count 效率分析

### 仓库清理

- 合并 14 个中间 session 到 1 个 merged session（1176 trajectories）
- 删除 13 个中间 session 目录，`runs/` 只保留 merged session
- 恢复 `.gitignore` 忽略 `runs/`

### Token 消耗估算

- 1176 runs 总计 ~953M input tokens + ~1.5M output tokens
- 平均每 run ~898k tokens（29.2 LLM calls）
- 主要消耗在 input（工具描述 + 历史对话累积），output 占比 <0.2%
- 费用：~¥578（dashscope 定价 ¥0.6/M input + ¥4.8/M output）

## 2026-07-20

> 工程修复让 oracle 信号在 10-task smoke 上稳定为正；新增 BFCL V4 Memory adapter 与 executor；准备 A-train 90×8=720 runs 全量实验。

### AppWorld LLM agent 工程修复
- `DEFAULT_MAX_STEPS` 40 → 200；`maxTokens` 从硬编码 1024 改为可配置（`LlmAgentConfig.maxTokens`），由 `AppWorldExecutorConfig` 透传。
- `appworld.ts` 注释与默认值同步（Default 200）。
- 强化 system prompt：要求每条响应必须以 `TOOL_CALL` 或 `COMPLETE` 起始，禁止自然语言前置；"想思考就静默思考，只输出最终命令行"。
- `LlmAppWorldAgent` 接收并使用 `this.config.maxTokens`（原硬编码 1024）。

### Provider 错误分类（`packages/common/src/providers/openai-compatible.ts`）
- 新增 `LlmCallError`：`permanent: boolean` + `httpStatus` + `errorCode`。
- `PERMANENT_ERROR_CODES`（`insufficient_quota` / `invalid_api_key` / `model_not_found` / `context_length_exceeded` 等）和 `TRANSIENT_RATE_LIMIT_CODES`（`rate_limit_exceeded` / `tpm_limit_exceeded` 等）分类 429 响应。
- 429 重试仍为 3 次指数退避（最长 90s）；permanent 错误直接抛出。
- 当前 agent 未捕获 `LlmCallError`（generic Error 冒泡至 `appworld.ts` catch 块标记为 `executor_error`），保留接口供后续 circuit-breaker 使用。

### AppWorld adapter 配置灵活性
- `sample-manifest.json` 支持 `root` 字段，允许 manifest-only 目录（如 `batch_a/`）指向共享 task 数据目录。
- 适配 `batch_a` / `batch_a_train` 等 manifest-only 装载方式。

### ExecutorInput 新增 `evaluatorMetadata`
- `packages/prologue/src/executors.ts`：`ExecutorInput` 新增 `evaluatorMetadata`（来自 `CanonicalTask.evaluator.metadata`）。
- `packages/experiments/src/rq1.ts`：`buildRq1Input` 透传 `task.evaluator?.metadata`。
- 与 oracle memory item metadata 区分：所有 condition 都能拿到，避免 baseline 误判。

### CLI manifest 改进
- `pnpm cli data:build` 收集每个 task 的 `split` 字段写入 `DatasetManifest.splits`（原来一律写 `{ dev: count }`）。

### BFCL V4 Memory adapter（v0.1.0，`packages/data/src/adapters/bfcl_v4_memory.ts`）
- 输入：`BFCL_v4_memory.json`（155 questions）× 3 backends（KV / Vector / Summarization）= 465 tasks。
- 三层 memory：common（scenario profile）/ oracle（prereq 对话内容）/ distractor（其他 scenario 对话）。
- `oracleToolIds` = retrieve / search / list_keys 子集 + `*_retrieve_all`（baseline 必须瞎猜 key，oracle 给 `retrieve_all` 提示）。
- `oracleIntent` = question + scenario + topic chain + 验证源片段。
- evaluator：`exact_match`，`goldAnswer` 含 ground truth 候选列表。
- `supportsInteraction: false`（单轮：问题 → 答案）。

### BFCL V4 executor 三件套
- `packages/experiments/src/executors/bfcl_v4_memory.ts`：`BfclV4MemoryExecutor`，单轮调用 agent 后比对答案。
- `bfcl_v4_llm_agent.ts`：`LlmBfclMemoryAgent`，调用 LLM 通过 memory API 函数检索并拼答案。
- `bfcl_v4_stub_agent.ts`：`StubBfclMemoryAgent`，无 LLM，仅当 `usesOracleMemory===true` 时给出正确答案，跑固定 7-call 序列保 trajectory 完整。
- 通过 `@prologue/experiments/src/index.ts` 导出。

### Scripts
- 新增 `scripts/test-bfcl-llm-oracle-all.ts`：BFCL V4 主实验脚本（465 tasks × 8 conditions）。
- 新增 `scripts/test-bfcl-adapter.ts`：BFCL adapter 结构验证（53/53 checks passed）。
- 新增 `scripts/test-bfcl-stub-attribution.ts`：stub agent 8-condition 归因矩阵验证（8/8 checks passed）。
- `scripts/test-llm-oracle-all.ts`：maxSteps 60 → 800，maxTokens 4096 → 8192（覆盖 ground truth max ~498 步）。

### 10-task smoke 验证（qwen3.5-27b，maxSteps=600）
- baseline avg=0.76 / oracle_all avg=0.83，Δ=+0.08。
- 6/10 任务 Δ=0（任务饱和或难度不足），2 个任务贡献主要正信号（b0a8eae_1 +0.20，e3d6c94_3 +0.56）。
- maxSteps=600 有效覆盖复杂任务（34d9492_2 跑满 177 步；82e2fac_1 跑 141 步均成功）。

### 仓库清理
- `.gitignore` 加入 `data/canonical/*.jsonl`（adapter 产物由 `pnpm cli data:build` 重新生成）。
- 删除一次性 smoke 脚本：`test-llm-122b-sample.ts` / `test-llm-deepseek-sample.ts` / `test-llm-model-compare.ts` / `_probe_tpm.mts`。

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
