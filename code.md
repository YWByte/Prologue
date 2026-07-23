# Context Prologue 代码仓库结构

> 仓库根目录：`/Users/wondery/paper/Prologue/`
> 项目名：`context-prologue`（pnpm monorepo，TypeScript-only，8 个 workspace packages）
> 状态：仅 RQ1（oracle attribution）端到端实现；RQ2/RQ3/RQ4 接口已定义但无实现

## 三层架构总览

仓库按调用关系分为三层：

```mermaid
flowchart TB
    subgraph ENTRY["① 入口层"]
        CLI["packages/cli<br/>prologue CLI"]
        SCRIPT["scripts/<br/>编排脚本<br/>(并行/断点续跑)"]
        REPLAY["scripts/<br/>replay-*.ts<br/>(Stage 2 验证)"]
    end

    subgraph DATA["② 数据集层"]
        SCHEMAS["@prologue/schemas<br/>类型单一来源"]
        DATA_PKG["@prologue/data<br/>Dataset Adapters"]
        RAW["data/raw/<br/>原始 benchmark"]
        CANONICAL["data/canonical/<br/>CanonicalTask JSONL"]
    end

    subgraph EXP["③ 实验代码层"]
        subgraph CORE["实验核心"]
            PROLOGUE["@prologue/prologue<br/>Executor 接口"]
            EXPERIMENTS["@prologue/experiments<br/>RQ1 Runner + AppWorld Executor"]
            PYTHON["python/appworld/<br/>Python helpers"]
        end
        subgraph LOGGING["日志与会话"]
            LOG["@prologue/log<br/>JSONL 日志器"]
            SESSION["@prologue/session<br/>会话生命周期"]
            COMMON["@prologue/common<br/>LLM Client + Env"]
        end
        RUNS["runs/&ltsessionId&gt/<br/>实验产物"]
    end

    ENTRY --> DATA
    ENTRY --> EXP
    DATA --> EXP
    EXP --> LOGGING
    EXP --> RUNS
    LOGGING --> RUNS
```

| 层 | 包/目录 | 职责 |
|---|---|---|
| ① 入口层 | `packages/cli`, `scripts/` | CLI 命令 + 实验编排脚本，触发数据构建和实验运行 |
| ② 数据集层 | `packages/schemas`, `packages/data`, `data/` | 定义 CanonicalTask schema + 适配器把原始 benchmark 转为标准化 JSONL |
| ③ 实验代码层 | `packages/prologue`, `packages/experiments`, `packages/common`, `packages/session`, `packages/log`, `python/`, `runs/` | RQ1 ablation 主循环 + AppWorld executor + LLM 客户端 + 日志会话 + Python helpers |

## 包依赖关系

```mermaid
flowchart BT
    schemas["@prologue/schemas<br/>(zod 类型)"]
    log["@prologue/log"]
    session["@prologue/session"]
    common["@prologue/common<br/>(LLM/env)"]
    data["@prologue/data<br/>(adapters)"]
    prologue["@prologue/prologue<br/>(接口 only)"]
    experiments["@prologue/experiments<br/>(RQ1 + Executor)"]
    cli["@prologue/cli"]

    log --> schemas
    session --> log
    session --> schemas
    common --> log
    common --> schemas
    common --> session
    data --> schemas
    data --> session
    prologue --> common
    prologue --> schemas
    experiments --> common
    experiments --> data
    experiments --> prologue
    experiments --> schemas
    experiments --> session
    cli --> common
    cli --> data
    cli --> experiments
    cli --> schemas
    cli --> session
```

底层 `schemas` 是单一类型来源，所有包向上依赖。`prologue` 是接口包（无实现），具体执行逻辑在 `experiments`。

---

# ① 入口层

入口层提供三类调用方式：CLI 通用入口、编排脚本（实际跑实验用）、回放验证脚本。

## 入口调用流程

```mermaid
flowchart LR
    USER["用户"]

    subgraph ENTRY_POINTS["入口选择"]
        CLI_CMD["pnpm cli data:build<br/>pnpm cli rq1:mock<br/>pnpm cli rq1:run"]
        SCRIPT_CMD["pnpm exec tsx<br/>scripts/test-llm-oracle-all.ts"]
        REPLAY_CMD["pnpm exec tsx<br/>scripts/replay-*.ts"]
    end

    subgraph DEST["执行目标"]
        ADAPTER["AppWorldAdapter<br/>BfclV4MemoryAdapter"]
        RUNNER_MOCK["runRq1Mock<br/>(无后端)"]
        RUNNER_REAL["runRq1Real<br/>+ AppWorldExecutor"]
        REPLAY_EXEC["AppWorldToolExecutor<br/>回放 ground truth"]
    end

    USER --> CLI_CMD
    USER --> SCRIPT_CMD
    USER --> REPLAY_CMD

    CLI_CMD -->|data:build| ADAPTER
    CLI_CMD -->|rq1:mock| RUNNER_MOCK
    CLI_CMD -->|rq1:run| RUNNER_REAL
    SCRIPT_CMD --> RUNNER_REAL
    REPLAY_CMD --> REPLAY_EXEC
```

## `packages/cli` — prologue CLI

**路径**：`packages/cli/src/index.ts`（293 行）
**binary**：`prologue` → `dist/index.js`

| 命令 | 用途 | 关键参数 |
|---|---|---|
| `data:build` | 跑 adapter，产出 CanonicalTask JSONL + manifest | `--source appworld/bfcl_v4_memory` `--raw <path>` `--out <path>` |
| `rq1:mock` | 跑 mock RQ1（无 LLM，无后端；success = `usesOracleMemory && usesOracleTool`） | `--tasks <canonical.jsonl>` |
| `rq1:run` | 跑真实 RQ1，配 `AppWorldExecutor` | `--tasks` `--llm-provider` `--llm-model` `--max-steps` 等 |

**路径解析**：相对路径基于 `INIT_CWD`（pnpm 注入），任意目录都能跑 `pnpm cli`。

## `scripts/` — 顶层编排脚本（实际跑实验的入口）

| 脚本 | 行数 | 用途 |
|---|---|---|
| `test-llm-oracle-all.ts` | 443 | **主 RQ1 LLM 实验驱动器**。支持 `appworld-batch_a_train.jsonl`（90 task）或 `appworld-batch_a.jsonl`（147 task）。自实现 worker pool（`runConcurrency: 10`）、checkpoint、断点续跑（`resumeValidFrom`）、provider_error/executor_error 分类、汇总打印 |
| `test-bfcl-llm-oracle-all.ts` | - | BFCL V4 主实验驱动器。465 tasks × 8 conditions = 3720 runs |
| `test-bfcl-adapter.ts` | - | BFCL adapter 结构验证（53 checks）|
| `test-bfcl-stub-attribution.ts` | - | BFCL stub agent 8-condition 归因矩阵验证 |
| `analyze-rq1-results.ts` | 230 | RQ1 结果分析脚本。从 session.json 读取 trajectories，按 condition 统计 mean/median/min/max/success，计算 delta vs baseline、交互效应（synergy/antagonism）、per-task 分布、step count 效率 |
| `replay-ground-truth.ts` | 228 | Stage 2 验证（5-task sample）。加载 canonical，每 task 启 AppWorld server，回放 `api_calls.json` 到 `AppWorldToolExecutor`，验证全部成功。无 LLM |
| `replay-batch-a-sample.ts` | 173 | Stage 2 验证（全 A 批）。从 `/tmp/replay-targets.json` 读目标，覆盖 sample_5 未覆盖的多 app / path+body 场景 |

**`test-llm-oracle-all.ts` 关键配置**：
- `llmProvider: "siliconflow"`（本地开发）/ `"vllm"`（服务器）/ `"dashscope"`（阿里云）
- `llmModel: "Qwen/Qwen3.5-27B"`
- `maxSteps: 800`, `maxTokens: 4096`, `enableThinking: false`
- `rpm: 1000`, `apiMaxConcurrency: 50`, `runConcurrency: 10`
- `basePort: 9100`, `checkpointEvery: 50`
- `resumeValidFrom`: 支持从指定 session 的 checkpoint.json 恢复，跳过 valid runs，重跑 executor_error/provider_error
- `appworldRoot` / `pythonPath` 支持环境变量（`PROLOGUE_APPWORLD_ROOT` / `PROLOGUE_APPWORLD_PYTHON`）
- 错误分类：`LlmCallError` → `provider_error`（API 提供商错误），其他 → `executor_error`（AppWorld server/Python 错误）

---

# ② 数据集层

数据集层定义统一的 `CanonicalTask` schema，并通过 adapter 把不同 benchmark 的原始数据转为这个格式。

## 数据集层结构

```mermaid
flowchart LR
    subgraph RAW_DATA["原始 benchmark (data/raw/, gitignored)"]
        APPWORLD_RAW["appworld/<br/>tasks/*/specs.json<br/>ground_truth/*<br/>base_dbs/*.db<br/>api_docs/openapi/*.json"]
        BFCL_RAW["bfcl_v4_memory/<br/>BFCL_v4_memory.json<br/>memory_prereq_conversation/*<br/>multi_turn_func_doc/*<br/>possible_answer/*"]
    end

    subgraph ADAPTERS["packages/data/src/adapters/"]
        APPWORLD_ADAPTER["AppWorldAdapter v0.2.0<br/>(654 行)"]
        BFCL_ADAPTER["BfclV4MemoryAdapter v0.1.0<br/>(~290 行)"]
    end

    subgraph SCHEMAS_PKG["packages/schemas/"]
        CANONICAL_SCHEMA["canonicalTaskSchema<br/>(zod)"]
    end

    subgraph CANONICAL_OUT["data/canonical/ (产物)"]
        APPWORLD_OUT["appworld-batch_a.jsonl (147)<br/>appworld-batch_a_train.jsonl (90)<br/>appworld-sample_5.jsonl (5)"]
        BFCL_OUT["bfcl_v4_memory.jsonl (465)<br/>+ manifest.json"]
    end

    APPWORLD_RAW --> APPWORLD_ADAPTER
    BFCL_RAW --> BFCL_ADAPTER
    SCHEMAS_PKG --> ADAPTERS
    APPWORLD_ADAPTER --> CANONICAL_OUT
    BFCL_ADAPTER --> CANONICAL_OUT
    CANONICAL_OUT -.->|读取时| SCHEMAS_PKG
```

## `packages/schemas` — 类型单一来源

**路径**：`packages/schemas/src/index.ts`（165 行）
**依赖**：`zod ^3.24.1`（唯一外部依赖）

定义所有数据形状的 Zod schema + 推断 TS 类型，其他包只 import 不重复定义。

**关键导出**：

| 类型 | 用途 |
|---|---|
| `CanonicalTask` | 标准化任务格式（见下方） |
| `MemoryItem` | `{id, type, content, source?, timestamp?, metadata}` |
| `ToolItem` | `{id, name, description, schema?, type, metadata}` |
| `EvaluatorSpec` | `{type, entrypoint?, goldAnswer?, metadata}` |
| `DatasetCapability` | `{hasOracleIntent/Memory/Tool, hasExecutableEval, supportsInteraction}` |
| `DatasetManifest` | 数据集元信息 |
| `VerifierExample` | RQ3 verifier 训练样本（接口已定义，无实现） |
| `LogEvent`, `TrajectoryStep`, `AgentTrajectory`, `SessionFile` | 日志与会话（见 ③ 日志层） |
| `Rq`, `Split`, `MissingType` | 枚举 |

### CanonicalTask 格式

```json
{
  "taskId": "50e1ac9_1",
  "source": "appworld",
  "domain": "spotify",
  "split": "dev",
  "query": "原始用户 query（主方法唯一可读的输入字段之一）",
  "oracleIntent": "<query + 操作约束（仅 oracle 条件注入）>",
  "memoryPool": [
    {"id":"...:memory:supervisor_profile","type":"profile","metadata":{"memoryRole":"common"}},
    {"id":"...:memory:public_data","type":"evidence","metadata":{"memoryRole":"oracle"}},
    {"id":"...:memory:distractor:...","metadata":{"memoryRole":"distractor"}}
  ],
  "commonMemoryIds":   ["...:memory:supervisor_profile"],
  "oracleMemoryIds":   ["...:memory:public_data"],
  "distractorMemoryIds":["...:memory:distractor:..."],
  "toolPool":     [{"id":"supervisor__show_profile","name":"...","type":"api","schema":{...}}],
  "oracleToolIds":["supervisor__show_profile","spotify__login","..."],
  "evaluator": {"type":"programmatic","entrypoint":"appworld:evaluate","goldAnswer":"..."},
  "capabilities": {"hasOracleIntent":true,"hasOracleMemory":true,"hasOracleTool":true,"hasExecutableEval":true,"supportsInteraction":true},
  "metadata": {"adapterVersion":"0.2.0","rawTaskId":"...","requiredApps":["spotify"],"...":"..."}
}
```

**关键约束**：主方法只能访问 `query + memoryPool + toolPool`；`oracleIntent / oracleMemoryIds / oracleToolIds` 仅用于 oracle 归因、标签构造、评估。

## `packages/data` — Dataset Adapters

**路径**：`packages/data/src/`
**依赖**：`@prologue/schemas`, `@prologue/session`

**核心接口**：

```ts
export interface DatasetAdapter {
  readonly source: string;
  readonly version: string;
  convert(rawRoot: string): AsyncIterable<CanonicalTask> | Iterable<CanonicalTask>;
}
```

**辅助函数**：
- `writeCanonicalTasks(tasks, outPath)` — 逐条 `canonicalTaskSchema.parse` 校验后写 JSONL
- `readCanonicalTasks(path)` — 读 JSONL 并 parse
- `writeDatasetManifest` / `buildDatasetManifest`

### 已实现 Adapters

#### `AppWorldAdapter` v0.2.0（`adapters/appworld.ts`，654 行）

**输入**：`data/raw/appworld/`，包含 `tasks/<task_id>/`（specs.json + ground_truth/*）+ `base_dbs/` + `api_docs/openapi/`

```mermaid
flowchart TD
    START["convert(rawRoot)<br/>async generator"]
    LOAD["加载 specs.json + ground_truth/*<br/>(required_apps, api_calls, public_data, answer)"]
    TOOL_APPS["toolApps = supervisor + requiredApps + 1 distractor"]
    LOAD_TOOLS["加载 api_docs/openapi/&ltapp&gt.json<br/>→ ToolItem[]"]
    MATCH_GT["matchEndpoint()<br/>api_calls.json → groundTruthToolIds"]
    ORACLE_TOOLS["buildOracleToolIds()<br/>supervisor essentials + login + 只读工具 +<br/>真实 mutation 工具 + GT"]
    MEM_POOL["buildMemoryPool() 三层:<br/>common (supervisor_profile/auth/required_apps)<br/>oracle (public_data 编译为 hint + app_user_library)<br/>distractor (spotify_other_user + cross-domain app_db_summary)"]
    INFER_INTENT["inferOracleIntent()<br/>public_data 编译为操作约束<br/>(threshold_duration+datetime → min/max_created_at 等)"]
    YIELD["yield CanonicalTask"]

    START --> LOAD --> TOOL_APPS --> LOAD_TOOLS --> MATCH_GT
    MATCH_GT --> ORACLE_TOOLS --> MEM_POOL --> INFER_INTENT --> YIELD
```

**关键设计**：
- `oracleToolIds` 是 "tool closure"：保证 oracle 条件下任务可解，但不直接给 ground truth（保留推理空间）
- 三层 memory layering（common / oracle / distractor）对应 RQ1 的 baseline / oracle / 干扰对照
- `inferOperationalHints` 把抽象约束（如 `threshold_duration: "month"`）编译成具体操作（具体日期范围）
- SQLite 访问用 `sqlite3 -json` CLI（不是 Node sqlite 库）

#### `BfclV4MemoryAdapter` v0.1.0（`adapters/bfcl_v4_memory.ts`，~290 行）

**输入**：`data/raw/bfcl_v4_memory/`，包含：
- `BFCL_v4_memory.json`（155 测试问题，NDJSON：id / question / scenario / involved_classes）
- `memory_prereq_conversation/memory_<scenario>.json`（5 scenarios，每个 4-10 段渐进式对话，用于预填充 memory）
- `multi_turn_func_doc/memory_{kv,vector,rec_sum}.json`（3 backends 共 32 个 memory operation 函数）
- `possible_answer/BFCL_v4_memory.json`（155 ground truth：id / ground_truth[] / source）

**BFCL V4 Memory 三组件映射**：

```mermaid
flowchart LR
    subgraph INPUT["BFCL V4 原始数据"]
        Q["测试问题<br/>(155 个)"]
        PREREQ["prereq 对话<br/>(5 scenarios)"]
        FUNC["memory API 函数<br/>(3 backends)"]
        GT["ground truth"]
    end

    subgraph MAPPING["Canonical 映射"]
        INTENT["Intent (I*)<br/>问题 + scenario + topic chain<br/>+ 验证源片段"]
        MEMORY["Memory (M*)<br/>prereq 对话内容<br/>(gold memory)"]
        TOOL["Tool (T*)<br/>search/retrieve/list_keys 子集<br/>+ *_retrieve_all"]
        DIST["Distractor<br/>其他 scenario 的 prereq"]
    end

    subgraph OUTPUT["CanonicalTask 输出"]
        OUT["465 tasks<br/>= 155 questions × 3 backends"]
    end

    Q --> INTENT
    PREREQ --> MEMORY
    PREREQ --> DIST
    FUNC --> TOOL
    GT --> INTENT
    INTENT --> OUT
    MEMORY --> OUT
    TOOL --> OUT
    DIST --> OUT
```

**关键设计**：
- 每个 question × backend = 一个 CanonicalTask（465 = 155 × 3）
- 测试时模型只能看 memory state（看不到 prereq 对话历史）—— 正好对应 M* oracle 注入
- 三层 memory：common（scenario profile）/ oracle（prereq 对话）/ distractor（其他 scenario 对话）
- `oracleToolIds` = retrieve/search/list_keys 子集 + `*_retrieve_all`（baseline 必须瞎猜 key，oracle 给 `retrieve_all` 提示）
- evaluator: `exact_match`，goldAnswer 含 ground truth 候选列表
- `supportsInteraction: false`（BFCL memory 是单轮测试：问题 → 答案）

**验证产出**：
- `data/canonical/bfcl_v4_memory.jsonl`（465 tasks，40 MB）
- `data/canonical/bfcl_v4_memory.manifest.json`
- 分布：customer 30 / finance 25 / healthcare 25 / notetaker 25 / student 50（每 scenario × 3 backends）

## `data/` 目录布局

```
data/
├── raw/                    ← 原始 benchmark（gitignored）
│   ├── appworld/           ← AppWorld 官方数据包
│   │   ├── data/tasks/<task_id>/ (specs.json, ground_truth/*, dbs/*)
│   │   ├── data/base_dbs/  (12 sqlite)
│   │   ├── data/api_docs/openapi/<app>.json (10 spec)
│   │   ├── data/datasets/  (train/dev/test_normal/test_challenge.txt)
│   │   ├── sample/         (2-task sample)
│   │   ├── sample_5/       (5-task A-batch sample)
│   │   ├── batch_a/        (147-task manifest)
│   │   └── batch_a_train/  (90-task train manifest)
│   └── bfcl_v4_memory/     ← BFCL V4 memory 数据
│       ├── BFCL_v4_memory.json (155 questions)
│       ├── memory_prereq_conversation/memory_*.json (5 scenarios)
│       ├── multi_turn_func_doc/memory_*.json (3 backends)
│       └── possible_answer/BFCL_v4_memory.json (155 answers)
├── canonical/              ← adapter 产出的 CanonicalTask JSONL
│   ├── appworld-batch_a.jsonl (147 tasks)
│   ├── appworld-batch_a_train.jsonl (90 tasks)
│   ├── appworld-sample_5.jsonl (5 tasks)
│   ├── bfcl_v4_memory.jsonl (465 tasks) + .manifest.json
│   └── ...
└── examples/               ← 手写 schema demo（非真实实验）
    ├── canonical-tasks.jsonl
    ├── verifier-examples.jsonl
    └── ...
```

---

# ③ 实验代码层

实验代码层包含两个子模块：**实验核心**（RQ1 ablation 主循环 + Executor）和**日志记录**（日志器 + 会话生命周期 + LLM 客户端）。

## 实验代码层内部结构

```mermaid
flowchart TB
    subgraph CORE["实验核心"]
        RQ1["rq1.ts<br/>8 条件 ablation"]
        RQ1_REAL["rq1.real.ts<br/>真实 runner"]
        EXECUTOR["appworld.ts<br/>AppWorldExecutor"]
        AGENTS["appworld_llm_agent.ts<br/>appworld_stub_agent.ts"]
        TOOLS["appworld_http.ts<br/>AppWorldToolExecutor"]
        SERVER["appworld_server.ts<br/>AppWorldServerManager"]
        PY["appworld_python.ts<br/>init/eval task"]
        PROLOGUE_IF["prologue/src/<br/>Executor 接口"]
    end

    subgraph LOGGING["日志与会话"]
        COMMON["@prologue/common<br/>LlmClient + Providers + env"]
        SESSION["@prologue/session<br/>Session 生命周期"]
        LOG["@prologue/log<br/>JSONL Logger"]
    end

    subgraph RUNTIME["运行时产物"]
        RUNS["runs/&ltsessionId&gt/<br/>session.json<br/>log.jsonl<br/>checkpoint.json"]
    end

    RQ1 --> RQ1_REAL
    RQ1_REAL --> EXECUTOR
    EXECUTOR --> AGENTS
    EXECUTOR --> SERVER
    EXECUTOR --> PY
    AGENTS --> TOOLS
    EXECUTOR --> TOOLS
    PROLOGUE_IF -.->|接口约束| EXECUTOR

    EXECUTOR --> COMMON
    AGENTS --> COMMON
    RQ1_REAL --> SESSION
    SESSION --> LOG
    SESSION --> RUNS
    LOG --> RUNS
    COMMON --> RUNS
```

---

## ③-A 实验核心

### RQ1 八条件 Ablation

**路径**：`packages/experiments/src/rq1.ts`（216 行）

```mermaid
flowchart TD
    TASK["CanonicalTask"]
    CONDITIONS["8 个条件<br/>RQ1_CONDITIONS"]

    subgraph ABLATION["条件矩阵"]
        BASE["baseline<br/>(common memory + full tool pool)"]
        I["oracle_intent<br/>(+ I*)"]
        M["oracle_memory<br/>(+ M*)"]
        T["oracle_tool<br/>(+ T*)"]
        IM["oracle_intent_memory"]
        IT["oracle_intent_tool"]
        MT["oracle_memory_tool"]
        ALL["oracle_all<br/>(I* + M* + T*)"]
    end

    BUILD["buildRq1Input(task, condition)<br/>构建 ExecutorInput"]
    EXEC["Executor.execute(input)"]
    RESULT["ExecutorResult<br/>{success, score, steps}"]

    TASK --> CONDITIONS --> ABLATION
    ABLATION --> BUILD --> EXEC --> RESULT
```

**8 条件 → Oracle 标志**：

| condition | I | M | T | 说明 |
|---|---|---|---|---|
| `baseline` | - | - | - | 只给 common memory + 全工具池 |
| `oracle_intent` | ✓ | - | - | 注入 oracleIntent |
| `oracle_memory` | - | ✓ | - | common + oracle memory |
| `oracle_tool` | - | - | ✓ | 只给 oracleToolIds 子集 |
| `oracle_intent_memory` | ✓ | ✓ | - | I + M |
| `oracle_intent_tool` | ✓ | - | ✓ | I + T |
| `oracle_memory_tool` | - | ✓ | ✓ | M + T |
| `oracle_all` | ✓ | ✓ | ✓ | 三组件全 oracle（上限） |

**`buildRq1Input(task, condition)` 关键逻辑**：

```mermaid
flowchart TD
    IN["task, condition"]
    VALIDATE["校验 task 有对应 oracle 字段"]
    COMMON["commonMemory = task.commonMemoryIds 对应项<br/>(旧 task fallback: 非 oracle 非 distractor)"]
    ORACLE_MEM{"condition 用<br/>oracle memory?"}
    OM_YES["oracleMemory = task.oracleMemoryIds 对应项"]
    OM_NO["oracleMemory = []"]
    FINAL_MEM["memory = uniqueById(commonMemory + oracleMemory)<br/>⚠️ baseline 只有 commonMemory"]
    TOOL{"condition 用<br/>oracle tool?"}
    T_YES["tools = selectByIds(toolPool, oracleToolIds)"]
    T_NO["tools = 完整 toolPool"]
    INTENT{"condition 用<br/>oracle intent?"}
    I_YES["intentSpec = task.oracleIntent"]
    I_NO["intentSpec = undefined"]
    OUT["Rq1ExperimentInput"]

    IN --> VALIDATE --> COMMON --> ORACLE_MEM
    ORACLE_MEM -->|Yes| OM_YES --> FINAL_MEM
    ORACLE_MEM -->|No| OM_NO --> FINAL_MEM
    FINAL_MEM --> TOOL
    TOOL -->|Yes| T_YES --> INTENT
    TOOL -->|No| T_NO --> INTENT
    INTENT -->|Yes| I_YES --> OUT
    INTENT -->|No| I_NO --> OUT
```

**关键 bugfix（2026-07-19）**：baseline 之前误用整个 `memoryPool`，现修正为只取 `commonMemory`，保证 baseline 与 oracle_memory 之间的差值确实反映 oracle memory 的边际贡献。

### Runner

| 文件 | 用途 |
|---|---|
| `rq1.ts` | 定义 `RQ1_CONDITIONS`、`buildRq1Input`、`runRq1Mock`（mock success = `usesOracleMemory && usesOracleTool`，无后端，仅校验逻辑） |
| `rq1.real.ts`（128 行） | `runRq1Real(tasks, session, executor)` — 委托给 `Executor.execute`，写 `task_start`/`oracle_condition`/`eval_result` log event，加 trajectory，返回 per-condition 汇总。单次 (task, condition) 失败不中断整体运行 |

### `@prologue/prologue` — 接口包（无实现）

**路径**：`packages/prologue/src/`

定义抽象接口，具体实现位于 `@prologue/experiments`：

```ts
// index.ts
export type PrologueContext = { intent: string; memory: MemoryItem[]; tools: ToolItem[] };
export type VerifierOutput = { score: number; missing: "intent"|"memory"|"tool"|"multiple"|"none" };
export interface IntentClarifier { ... }
export interface MemoryGater { ... }
export interface ToolSelector { ... }
export interface SufficiencyVerifier { verify(task, context): Promise<VerifierOutput>; }

// executors.ts
export interface ExecutorInput {
  taskId, source, query,
  intentSpec?, memory: MemoryItem[], tools: ToolItem[],
  condition?, usesOracleIntent/Memory/Tool: boolean
}
export interface ExecutorResult { success, score?, reason?, steps, metadata? }
export interface Executor { execute(input): Promise<ExecutorResult>; }
export interface ToolExecutor { call(tool, args): Promise<ToolCallResult>; }
```

**状态**：所有接口 only，没有任何具体实现类。Sufficiency Verifier（RQ3）整块是 future work。

### `AppWorldExecutor` — 单次执行生命周期

**路径**：`packages/experiments/src/executors/appworld.ts`（237 行）

```mermaid
sequenceDiagram
    participant Exp as Experiment
    participant Exec as AppWorldExecutor
    participant Srv as ServerManager
    participant Py as Python Helpers
    participant Agent as LLM/Stub Agent
    participant Tool as ToolExecutor
    participant Eval as Evaluator

    Exp->>Exec: execute(ExecutorInput)
    Exec->>Exec: 分配 port (basePort 轮转)
    Exec->>Exec: experimentName = prefix_taskId_condition<br/>(memory→mem 替换避免 AppWorld evaluator 坑)
    Exec->>Srv: start(python serve_apis.py)
    Srv->>Srv: poll GET / until ready (60s)
    Exec->>Py: initAppWorldTask(mode=init)
    Py->>Py: _prepare_directories / _set_datetime / _save_state
    Exec->>Tool: new AppWorldToolExecutor(baseUrl)
    Exec->>Agent: run(input, toolExecutor)

    loop ReAct loop (max 40-60 steps)
        Agent->>Agent: build prompt (tools + memory + intent)
        Agent->>Agent: call LLM
        alt TOOL_CALL <id> <args>
            Agent->>Tool: call(tool, args)
            Tool->>Tool: 注入 access_token (per-app)
            Tool->>Tool: OpenAPI → fetch HTTP
            Tool-->>Agent: {ok, status, output}
            Agent->>Agent: redactSensitive (access_token/password)
            Agent->>Agent: append observation (truncate 4000 chars)
        else COMPLETE <answer>
            Agent-->>Exec: final answer
        end
    end

    Exec->>Py: initAppWorldTask(mode=save)
    Py->>Py: world.save_state(...)
    Exec->>Py: runAppWorldEval
    Py->>Eval: evaluate_task(task_id, experiment_name)
    Eval-->>Py: {success, num_tests, passes, failures}
    Exec->>Exec: score = passes.length / num_tests
    Exec->>Srv: stop (SIGTERM, SIGKILL 15s 后)
    Exec-->>Exp: ExecutorResult{success, score, steps}
```

**关键设计**：
- 单次执行失败不影响其他 run（不抛异常，返回 `success: false`）
- `experimentName` 中 `memory` → `mem` 替换：AppWorld evaluator 把路径含 `memory` 的当作 in-memory connection string
- per-app `access_token` 隔离：避免 LLM 从 history 复制错 app 的 token
- `redactSensitive`：递归 scrub `access_token`/`authorization`/`password` 为 `[REDACTED]`

### AppWorld Executor 子模块

| 文件 | 行数 | 职责 |
|---|---|---|
| `appworld.ts` | 237 | `AppWorldExecutor` 编排：port 分配 → server → init → agent → save → eval → stop |
| `appworld_http.ts` | 154 | `AppWorldToolExecutor`：OpenAPI → fetch，per-app token 存储（`tokensByApp`），auth 注入 |
| `appworld_server.ts` | 127 | `AppWorldServerManager`：管理 `python serve_apis.py` 子进程，poll `GET /` 就绪，SIGTERM 关闭 |
| `appworld_python.ts` | 159 | `initAppWorldTask`（mode: init/save）+ `runAppWorldEval`，subprocess + stdin/stdout JSON |
| `appworld_llm_agent.ts` | 343 | `LlmAppWorldAgent`：ReAct 风格，文本协议 `TOOL_CALL <id> <json>` / `COMPLETE <answer>`，token 隔离 + redaction |
| `appworld_stub_agent.ts` | 313 | `StubAppWorldAgent`：无 LLM，从 oracle memory 推导答案；仅 `usesOracleMemory===true` 时有答案；跑固定 7-call 序列保 trajectory 完整 |

### Agent 响应协议（`LlmAppWorldAgent`）

```
TOOL_CALL <tool_id> <json_args>   ← 调用工具
COMPLETE <answer>                  ← 提交最终答案
```

- 默认 `maxSteps=200`, `maxTokens=1024`, `temperature=0.3`, `enableThinking=false`
- prompt 强化：每条响应必须以 `TOOL_CALL` 或 `COMPLETE` 起始，禁止自然语言前置
- 工具输出截断 4000 字符
- 若 `maxSteps` 耗尽仍未 `COMPLETE`，尝试 `supervisor__complete_task` 提交最后一个 answer

### `python/appworld/` — Python Helpers

3 个薄包装，均通过 stdin/stdout 传 JSON，需在 `.venv-appworld/` 跑。**每个 task 必须新进程**：AppWorld 持有 process-level DB cache。

| 文件 | 行数 | 用途 |
|---|---|---|
| `serve_apis.py` | 22 | 包装 `appworld.serve.apis.run`，参数 `--root --port`，长驻进程，TS 父进程 SIGTERM 关闭 |
| `init_task.py` | 71 | `mode="init"` 跑 `_prepare_directories` / `_execute_preamble` / `_set_datetime` / `_save_state`（手工跳过 `close_all()` 避免 time_freezer bug）；`mode="save"` 跑 `world.save_state(...)` 持久化 DB 变更 |
| `eval_task.py` | 39 | 调 `appworld.evaluate_task(...)`，输出 `tracker.to_dict()`（`success, difficulty, num_tests, passes, failures`） |

---

## ③-B 日志与会话

### `@prologue/session` — 会话生命周期

**路径**：`packages/session/src/index.ts`（66 行）
**依赖**：`@prologue/log`, `@prologue/schemas`

每次实验创建 `<runsRoot>/<sessionId>/` 目录，持久化 `session.json`，挂载 logger。

```mermaid
sequenceDiagram
    participant Exp as Experiment
    participant Sess as Session
    participant Log as Logger
    participant FS as Filesystem

    Exp->>Sess: start({rq, method, config, dataset, models})
    Sess->>Sess: 派生 sessionId<br/>(ISO timestamp + rq + method + 8-char UUID)
    Sess->>Sess: 计算 configHash (sha256 前 12 hex)
    Sess->>FS: 创建 runs/&ltsessionId&gt/ 目录
    Sess->>FS: 写初始 session.json
    Sess->>Log: createLogger(sessionId, runDir)
    Log->>FS: append log.jsonl: session_start

    loop 实验运行中
        Exp->>Sess: addTrajectory(traj)
        Exp->>Log: info("eval_result", payload)
        Log->>FS: append log.jsonl
        Exp->>Sess: flush() (周期性)
        Sess->>FS: 写 session.json (覆盖)
    end

    Exp->>Sess: finish(status)
    Sess->>Sess: 设 finishedAt + status
    Sess->>Log: info("session_end")
    Log->>FS: append log.jsonl: session_end
    Sess->>FS: 最终 flush session.json
```

**sessionId 格式**：`2026-07-20T03-51-09-419Z_rq1_oracle_attribution_llm_a_train_1a1af548`

### `@prologue/log` — JSONL 日志器

**路径**：`packages/log/src/index.ts`（44 行）
**依赖**：`@prologue/schemas`

Append-only JSONL logger，每行一个 `LogEvent`，写入 `<runDir>/log.jsonl`。

**LogEvent 结构**：

```ts
{
  eventId: string,    // randomUUID()
  sessionId: string,
  timestamp: string,  // ISO
  level: "debug" | "info" | "warn" | "error",
  type: string,       // "session_start" | "task_start" | "oracle_condition" | "eval_result" | "executor_error" | "session_end" | ...
  rq?: "rq1"|"rq2"|"rq3"|"rq4",
  taskId?: string,
  source?: string,
  method?: string,
  payload: unknown
}
```

**导出**：`Logger` 类（`debug/info/warn/error(type, payload)`）+ `createLogger(sessionId, runDir)`

### `@prologue/common` — LLM Client + Providers + Env

**路径**：`packages/common/src/`
**依赖**：`@prologue/log`, `@prologue/schemas`, `@prologue/session`, `dotenv ^16.4.7`

```mermaid
flowchart LR
    subgraph COMMON_PKG["@prologue/common"]
        ENV["env.ts<br/>loadEnvIntoProcess()"]
        PROVIDERS["providers/index.ts<br/>PROVIDERS 注册表 + createClientFromEnv()"]
        OAI_COMPAT["providers/openai-compatible.ts<br/>OpenAiCompatibleClient<br/>(唯一客户端实现)"]
    end

    DOTENV[".env<br/>(DASHSCOPE_API_KEY 等)"]
    CALLER["调用方<br/>(agents / experiments)"]

    DOTENV --> ENV
    ENV --> PROVIDERS
    PROVIDERS -->|"4 provider factory<br/>全部 new OpenAiCompatibleClient"| OAI_COMPAT
    OAI_COMPAT --> CALLER
```

**5 个内置 provider**：

| Provider | Base URL | Env Var | 说明 |
|---|---|---|---|
| `siliconflow` | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` | 硅基流动 |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | OpenAI |
| `dashscope` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | 阿里云通义（Qwen 系列） |
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | DeepSeek |
| `vllm` | `http://localhost:4000/v1`（可 `VLLM_BASE_URL` 覆盖） | `VLLM_API_KEY`（可选，默认 `"EMPTY"`） | 本地 vLLM 服务器 |

**`OpenAiCompatibleClient` 关键特性**：
- 内置 `RateLimiter`（RPM + maxConcurrency，setTimeout 队列）
- 重试：指数退避，HTTP 429 退避更长
- `enable_thinking` 标志（Qwen 思考模式）
- 默认：timeout 120s，3 次重试，RPM 500，并发 20
- 错误分类：`PERMANENT_ERROR_CODES`（invalid_api_key 等，不重试）vs `TRANSIENT_RATE_LIMIT_CODES`（rate_limit_exceeded / limit_burst_rate / insufficient_quota 等，429 重试）
- **关键修复（2026-07-21）**：`insufficient_quota` 从 `PERMANENT_ERROR_CODES` 移到 `TRANSIENT_RATE_LIMIT_CODES`。DashScope 用 `HTTP 429 + insufficient_quota` 表示临时 TPM 限制（应重试），不是永久配额耗尽。修复前并发 5+ 时 429 被误判为永久错误导致不重试、全部 EXECUTOR_ERROR
- 导出接口：`LlmClient`（`call(input): Promise<LlmCallOutput>`）

## `runs/` — 实验产物

**路径**：`runs/`（gitignored）

每个 run 创建 `<ISO-timestamp>_<rq>_<method>_<8-char-uuid>/`：

```
runs/2026-07-20T03-51-09-419Z_rq1_oracle_attribution_llm_a_train_1a1af548/
├── session.json        # 完整 SessionFile (config/dataset/models/trajectories)
│                       # 1.8MB - 5.4MB
├── log.jsonl           # append-only LogEvent 流
└── checkpoint.json     # 仅 test-llm-oracle-all.ts runs 有
                        # {runDir, tasksPath, configHash, completed: RunResult[]}
```

**现有 sessions**：

| Session | 内容 | 状态 |
|---|---|---|
| `2026-07-19T12-16-40...rq1_..._701ba5b2` | qwen3.5-27b 5×8=40 run | ✅ oracle_all 0.83 vs baseline 0.69 (+0.14) |
| `2026-07-19T13-45-13...rq1_..._ce04b589` | qwen3.5-35b-a3b 5×8=40 run | ✅ oracle_all 0.79 vs baseline 0.69 (+0.10) |
| `2026-07-20T07-25-50...rq1_..._f2fc4928` | qwen3.5-27b 10×2=20 run smoke2 | ✅ oracle_all 0.83 vs baseline 0.76 (+0.08) |
| `2026-07-22T15-00-00...rq1_..._merged` | **batch_a 147×8=1176 runs 合并结果** | ✅ **oracle_all 0.748 vs baseline 0.692 (+8.1%)** |

---

# 实验执行入口与流程

## 三种执行方式

```mermaid
flowchart TB
    subgraph SMOKE["① Mock RQ1 (smoke test)"]
        MOCK_CMD["pnpm cli rq1:mock<br/>--tasks appworld-sample_5.jsonl"]
        MOCK_RUN["runRq1Mock<br/>success = usesOracleMemory && usesOracleTool"]
        MOCK_CMD --> MOCK_RUN
    end

    subgraph CLI_REAL["② 真实 RQ1 via CLI (单线程)"]
        CLI_CMD["pnpm cli rq1:run<br/>--tasks ...<br/>--llm-provider dashscope<br/>--llm-model qwen3.5-27b"]
        CLI_RUN["runRq1Real + AppWorldExecutor<br/>顺序执行"]
        CLI_CMD --> CLI_RUN
    end

    subgraph SCRIPT_REAL["③ 真实 RQ1 via 编排脚本 (并行, 实际使用)"]
        SCR_CMD["pnpm exec tsx<br/>scripts/test-llm-oracle-all.ts"]
        SCR_RUN["自实现 worker pool<br/>runConcurrency=20<br/>checkpoint + 断点续跑"]
        SCR_CMD --> SCR_RUN
    end
```

## 完整实验流程（端到端）

```mermaid
flowchart TD
    BUILD_RAW["1. 下载原始数据<br/>(data/raw/)"]
    BUILD_CANONICAL["2. 跑 adapter<br/>pnpm cli data:build<br/>→ data/canonical/*.jsonl"]
    RUN_RQ1["3. 跑 RQ1 ablation<br/>8 conditions × N tasks"]
    LOGGING_RUNTIME["4. 实时日志<br/>session.json + log.jsonl"]
    CHECKPOINT["5. checkpoint<br/>每 50 runs flush"]
    RESULT["6. 汇总<br/>per-condition / per-task"]

    BUILD_RAW --> BUILD_CANONICAL --> RUN_RQ1
    RUN_RQ1 --> LOGGING_RUNTIME
    LOGGING_RUNTIME --> CHECKPOINT
    CHECKPOINT --> RESULT
```

---

# 配置文件与构建

## 配置文件

| 文件 | 用途 |
|---|---|
| `package.json`（root） | `name=context-prologue`, `version=0.1.0`, `private=true`, `type=module`, `packageManager=pnpm@9.15.0`。scripts: `build`/`typecheck`/`test`/`cli` |
| `pnpm-workspace.yaml` | `packages: ["packages/*"]` |
| `tsconfig.base.json` | ES2022 / NodeNext / strict / declaration+sourceMap / resolveJsonModule |
| 各包 `tsconfig.json` | 继承 base，`rootDir: src, outDir: dist` |
| `.env`（gitignored） | API keys（DashScope 等），`loadEnvIntoProcess()` 加载 |
| `.gitignore` | `node_modules/`, `dist/`, `.env`, `.venv-appworld/`, `data/raw/`, `runs/` |

## 构建流程

```bash
pnpm install         # 安装 workspace 依赖
pnpm build           # 按 topological 顺序跑各包 tsc -p tsconfig.json
pnpm typecheck       # build + 各包 --noEmit
pnpm test            # 各包 vitest run --passWithNoTests
```

**构建顺序**（`pnpm -r --sort build`）：schemas → log → session → common → data → prologue → experiments → cli

---

# 当前实验进度

| 维度 | 状态 |
|---|---|
| AppWorld adapter (v0.2.0) | ✅ 完成 |
| BFCL V4 Memory adapter (v0.1.0) | ✅ 完成（465 tasks） |
| RQ1 mock runner | ✅ 完成 |
| RQ1 real executor（stub + LLM agent） | ✅ 完成 |
| Per-app token 隔离 / 敏感字段 redaction | ✅ 完成 |
| 并行编排 + checkpointing + provider_error 分离 | ✅ 完成 |
| vLLM provider + 环境变量路径配置 | ✅ 完成 |
| 5-task smoke run（qwen3.5-27b / 35b-a3b） | ✅ oracle_all > baseline（+0.14 / +0.10） |
| 10-task smoke2（qwen3.5-27b，maxSteps=600 + STRICT prompt） | ✅ oracle_all 0.83 vs baseline 0.76（+0.08） |
| **batch_a 全量 147×8=1176 runs（qwen3.5-27b）** | ✅ **完成** — oracle_all 0.748 vs baseline 0.692（+8.1%） |
| BFCL V4 RQ1 全量实验 | ❌ 未开始（adapter + executor 已就绪） |
| RQ2 Prologue 方法 | ❌ 未开始 |
| RQ3 训练式 Verifier | ❌ 未开始（接口已定义） |
| RQ4 跨 benchmark 泛化 | ❌ 未开始 |
| τ²-bench / MemoryAgentBench adapter | ❌ 未开始 |

## 测试基础设施

- **框架**：vitest `^2.1.8`
- 每个包 `package.json`：`"test": "vitest run --passWithNoTests"`
- 仅 `@prologue/experiments` 有真实测试（3 文件，13 测试）：
  - `rq1.test.ts` — `buildRq1Input` 行为验证（baseline = common memory only，oracle_memory = common + oracle，旧 task fallback）
  - `appworld_http.test.ts` — URL 构建 / per-app token 隔离 / explicit token 优先
  - `appworld_llm_agent.test.ts` — per-app token 存储，敏感字段 redaction
- 全量 `pnpm test`：13/13 通过
