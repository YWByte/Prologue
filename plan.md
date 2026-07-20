# Context Prologue: Agent 执行前的显式上下文构建阶段

## 1. 问题

当前 agent 框架（ReAct / Reflexion / AutoGen / LangGraph）通常把上下文构建作为执行流中的隐式决策：意图是否清楚、memory 是否相关、工具是否合适，都在执行过程中边做边猜。这会使执行前错误（意图误判、memory 选错、工具选错）在后续推理和工具调用中被放大。

已有工作分别优化单一组件：SAGE-Agent 做工具参数级澄清；Agentic Memory 做记忆写入、管理和读取；Tool Selection Optimization 做工具选择；Context Engineering 提出 Write / Select / Compress / Isolate 操作，但未把意图、记忆、工具联合为执行前独立阶段。

**空白**：意图 + 记忆 + 工具三组件的执行前联合构建，以及其“充分性”判定，尚未被系统研究。

## 2. 核心 Idea

在 agent 执行前显式插入独立阶段 **Context Prologue**， 先构建可执行上下文，再进入执行：

1. **Intent Clarifier**：判断任务意图是否充分，不充分则澄清
2. **Memory Gater**：从记忆库选择相关子集
3. **Tool Selector**：从工具库选择相关子集
4. **Sufficiency Verifier**：判断 (意图, 记忆, 工具) 三元组是否足以支持任务完成；不充分则回到澄清与选择

Prologue 完成后冻结初始执行上下文，执行阶段只在该上下文内推理和调用工具。核心不是增加一步提示，而是把 agent 执行前的上下文充分性形式化为可学习、可判定、可消融的问题。

## 3. 研究问题

**RQ1（归因）**：agent 失败中多大比例可归因于执行前上下文不足，而非执行阶段推理错误？

**RQ2（方法）**：显式 Prologue 是否提升任务成功率和 token 效率？提升是否来自三组件联合，而非单组件改进？

**RQ3（判定）**：可训练 Sufficiency Verifier 能否准确预测上下文是否充分？其 AUC、校准误差和任务成功率是否一致？

**RQ4（泛化）**：Prologue 是否在多个 benchmark、多个 agent backbone、多个任务类型上稳定提升？

## 4. 方法

### 4.1 框架

```
[query]
    ↓
┌─ Context Prologue ──────────────┐
│ (1) Intent Clarifier             │
│ (2) Memory Gater                 │
│ (3) Tool Selector                │
│ (4) Sufficiency Verifier         │
│     → 充分？No → 回到 (1)-(3)    │
└──────────────────────────────────┘
    ↓ (冻结初始上下文)
[执行：ReAct / Reflexion / Planner-Executor]
    ↓
[答案]
```

### 4.2 形式化

给定任务 `x`、记忆库 `M`、工具库 `T`，Prologue 输出：

```
z = (i, m, t)
其中 i 为澄清后的意图，m ⊆ M，t ⊆ T
```

组件含义：

- **Intent Clarifier**：把原始 query 转为明确任务意图 `i`
- **Memory Gater**：从记忆库 `M` 中选择当前任务相关的 top-k 记忆 `m`
- **Tool Selector**：从工具库 `T` 中选择完成任务所需的 top-k 工具 `t`
- **Sufficiency Verifier**：判断 `(x, i, m, t)` 是否足以支持执行成功

Sufficiency Verifier 学习：

```
V(x, i, m, t) → P(success)
```

当 `V(x, i, m, t) ≥ τ` 时进入执行。目标是在固定总预算 `B` 下最大化任务成功率，并限制 Prologue 预算 `≤ αB`。

> 对每个 benchmark，我们先用 baseline 进行小规模预实验，取其 token 消耗的 90 分位数作为任务预算 B。所有方法共享相同B，以保证比较公平 。

### 4.3 Sufficiency Labels 自动构造

无需人工标注，通过执行结果和 oracle ablation 自动构造充分性标签：

- **正例**：给定 `(i, m, t)` 后任务成功
- **负例**：给定 `(i, m, t)` 后任务失败
- **Oracle-Intent**：替换为真实任务意图
- **Oracle-Memory**：替换为真实相关记忆
- **Oracle-Tool**：替换为真实所需工具
- **Oracle-All**：三者全替换

若替换某组件后失败转为成功，则该组件对应的上下文不足可被归因。组合 oracle 用于估计组件交互。

### 4.4 关键设计

- **显式分离**：Prologue 与执行阶段分离，先判断上下文充分性，再执行
- **可训练 Verifier**：使用 Qwen 系列开源小模型作为判别器，预测任务可解性和缺失来源
- **三组件联合**：意图、记忆、工具同时选择，避免单组件局部最优
- **预算控制**：Prologue 占总 token 预算固定比例（默认 20%）
- **受控冻结**：冻结初始上下文；工具返回结果仍作为执行观察进入轨迹

## 5. 实验设计

### 5.1 数据集：Context Prologue Suite

不直接在原始 benchmark 上写实验逻辑，而是通过 adapter 统一转换为 **Context Prologue Suite**。实验模块只读取统一格式，与具体数据集解耦。

统一样本格式：

```
{
  x: 原始 query,
  I*: 真实意图,
  M: 候选记忆库,
  M*: 真实相关记忆 ids,
  T: 候选工具库,
  T*: 真实所需工具 ids,
  E: 自动评价器,
  source / domain / metadata
}
```

主方法只能访问 `x, M, T`；`I*, M*, T*` 只用于 oracle 归因、标签构造和评估。

### 5.2 RQ1：Oracle Attribution

RQ1 不做“有无组件”的显然对比，而做候选池归因：正确记忆和工具存在于候选池中，oracle 条件将某一组件替换为真实子集，用于判断失败是否来自执行前选择错误。

候选池：

```
M = M* + M_distractor
T = T* + T_distractor
```

数据：

- **BFCL V4 (Memory track)**：由多轮用户对话、memory snapshot 和 memory operation APIs 构造 `I* / M* / T*`，作为三组件归因**首选主数据集**。其三组件在数据结构上天然分离（I=问题+场景、M=前置对话内容、T=记忆 API 子集），扣留任一组件不污染其余，归因信号最干净；执行链条短（调几次记忆 API → 拼答案），失败更可能来自 pre-execution context 不足而非执行错误，与 Prologue 论文理念最契合；三种 memory backend (KV/Vector/Summarization) 提供同题不同条件的天然控制变量
- **AppWorld**：由任务说明、app state、用户活动和 API 轨迹构造 `I* / M* / T*`，作为**对照数据集**。其执行链条长、状态空间大，失败中执行错误占比较高，用于验证归因方法在执行负担重的任务上仍成立（robustness check）
- **τ²-bench**：由用户目标和工具轨迹构造 `I* / T*`，加入同域工具干扰（注：原 τ³-bench 仍 WIP，采用稳定的 τ²-bench），作为多轮对话场景的补充
- **MemoryAgentBench / MemBench**：混合 gold memory、同主题干扰、过期记忆和冲突记忆，分析 memory selection failure（单组件深挖，作为补充）

设置：

- **Baseline**：`x + M + T`
- **I**：`x + I* + M + T`
- **M**：`x + M* + T`
- **T**：`x + M + T*`
- **I+M / I+T / M+T**：两两替换真实子集
- **I+M+T**：oracle 上限

用组合消融估计 intent / memory / tool 的边际贡献与交互贡献。指标：成功率提升、失败归因比例、组件交互项。

### 5.3 RQ2：方法主实验

数据：

- **BFCL V4 (Memory track)**：测试 memory-operation tool 调用、用户意图演化与 memory state 管理（主数据集）
- **AppWorld**：测试状态化 API、记忆选择和工具选择（对照数据集，验证执行重任务上的归因鲁棒性）
- **τ²-bench**：测试多轮澄清和工具调用
- **MemoryAgentBench / MemBench**：测试 memory-heavy 场景

方法只访问 `x, M, T`。`M` 和 `T` 包含真实项与干扰项，`I*, M*, T*` 不进入方法输入。

Baselines：

- 直接执行（ReAct / Reflexion）
- Planner-Executor
- 只做意图澄清
- 只做记忆选择
- 只做工具选择
- 三组件在执行中交错调用
- **Context Prologue（全部）**

控制：同模型、同总 token 预算、同工具库、同记忆库。指标：任务成功率、token 效率、工具调用次数、延迟。

### 5.4 RQ3：Verifier 质量

目标：验证“上下文充分性”是否可学习，并能用于 Prologue 停止与修复。

数据：

- 来自 **BFCL V4 / AppWorld / τ²-bench / MemoryAgentBench / MemBench** 的执行轨迹（BFCL V4 为主）
- 每个任务构造多个 `z = (i, m, t)`，执行后得到 `y_success`
- 通过 oracle 替换得到 `y_missing`
- 按 task id 划分 train / dev / test，避免同任务泄漏

定义：

```
z = (i, m, t)
sufficient(x, z) = 1 ⇔ Execute(A, x, z, B) succeeds
V(x, z) → { score: P(success), missing: intent / memory / tool / none }
```

模型：

- 底座：Qwen 系列开源小模型
- 形式：判别式 verifier，不生成长答案
- 输入：原始 query、澄清意图、top-k 原始记忆、top-k 工具字段
- 长度控制：top-k + 固定截断，不引入额外压缩模块

训练算法：

```
L = L_success + λ1 L_missing + λ2 L_rank
```

- `L_success`：充分性预测
- `L_missing`：缺失来源分类
- `L_rank`：同一任务内成功上下文高于失败上下文
- 阈值 `τ`：在 dev set 上校准，优先控制 False Sufficient Rate

#### RQ3.1：Verifier 能否预测任务成功？

标签：执行成功为正例，执行失败为负例。

训练：

- `BCE(score, y_success)`
- 同一任务内加入排序约束：`Rank(z_good, z_bad)`

指标：

- ROC AUC / PR AUC
- 校准误差
- False Sufficient Rate
- Verifier 分数与任务成功率相关性

#### RQ3.2：Verifier 能否定位缺失来源？

标签：若 oracle 替换某组件后由失败转成功，则该组件为缺失来源。

训练：

- `CE(missing, y_missing)`

指标：

- Missing Type Accuracy
- intent / memory / tool 分项准确率
- 缺失定位与 oracle attribution 的一致性

#### RQ3.3：Verifier 能否指导 Prologue 修复？

流程：

```
score < τ → 根据 missing 返回对应组件修复 → 再验证
score ≥ τ → 冻结初始上下文并执行
```

对比：

- 无 Verifier，直接执行
- 无 Verifier，固定轮数 Prologue
- LLM-as-Verifier
- 可训练 Verifier
- Oracle Verifier

指标：

- 修复后成功率提升
- 平均 Prologue 轮数
- token 效率
- 阈值 `τ` 与任务成功率关系

### 5.5 RQ4：消融与泛化

数据：

- **BFCL V4 (Memory track)**：memory backend 切换（KV/Vector/Summarization）和工具库规模泛化（主数据集，提供同题跨 backend 控制变量）
- **AppWorld**：跨 app 域和工具库规模泛化（对照数据集）
- **BrowserGym / WorkArena / BrowseComp**：web-agent 和企业流程泛化
- **Terminal-Bench 2.0 / SWE-Lancer**：coding / terminal 泛化

设置：在主数据集训练 verifier，在 held-out benchmark / domain / executor 上测试。

消融：

- 三组件：单独 / 两两 / 全部
- Prologue 预算比例：10% / 20% / 30% / 50%
- Verifier 阈值：低 / 中 / 高
- 标签来源：执行结果 / oracle ablation / 混合标签
- 冻结策略：冻结工具子集 / 冻结记忆子集 / 全冻结初始上下文

Backbone：

- GPT-4o / Claude / Qwen 7B、32B、72B / Llama 8B、70B

任务类型：

- tool-use / retrieval / memory-heavy / coding

### 5.6 资源规划

- 总跑次约 800-1200（含 oracle、消融、跨 benchmark）
- 8 卡 A6000 跑开源模型与 verifier
- API 模型用于主实验和强 baseline
- 预期结果：跨 benchmark 显著提升任务成功率，并提升 token 效率

## 6. Novelty

- 提出 agent 执行前上下文充分性问题
- 将意图、记忆、工具联合为独立 Prologue 阶段
- 自动构造 sufficiency labels，训练 Sufficiency Verifier
- 用 oracle attribution 量化执行前失败来源
- 在固定预算下评估成功率、效率和泛化性

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 被判为 prompt 工程 | 可训练 Verifier + 自动标签 + 受控预算 + oracle 归因 |
| 与单组件工作重叠 | 强调三组件联合、组件交互和执行前充分性 |
| Verifier 预测不准 | 报告 AUC、校准误差、阈值曲线；比较 LLM 与训练模型 |
| benchmark 不覆盖记忆 | 构造记忆增强任务，加入相关记忆与干扰记忆 |
| Prologue 增加成本 | 固定总预算，报告 token 效率和延迟 |
| 冻结上下文过强 | 冻结初始上下文，保留工具观察；加入冻结策略消融 |

## 8. 时间线（ARR 2026-08-03）

- Week 1：Oracle attribution + sufficiency labels 构造
- Week 2：Prologue 实现 + 可训练 Verifier
- Week 3：主实验 + 强 baseline
- Week 4：消融 + 跨 benchmark 泛化
- Week 5：分析 + 写作

## 9. 论文骨架

| 部分 | 内容 | 页数 |
|---|---|---|
| Intro | 执行前失败 + 上下文充分性 + 贡献 | 1.2 |
| Related Work | 澄清 / 记忆 / 工具选择 / 上下文工程 / agent 执行框架 | 1 |
| Method | Prologue 四组件 + Verifier + 自动标签 | 2 |
| Experiments | RQ1+RQ2+RQ3+RQ4 | 2.5 |
| Ablation | 组件、预算、阈值、冻结策略 | 1 |
| Analysis | 失败归因、效率、泛化、弱模型收益 | 0.8 |
| Limitations | 交互成本、oracle 构造、动态任务 | 0.5 |

## 10. 关键参考文献

- SAGE-Agent "Structured Uncertainty guided Clarification for LLM Agents" (ACL 2026 Findings)
- "Coding Agents Are Guessing: Measuring Action-Boundary" (arXiv 2607.02294, 2026-07)
- "Agentic Memory: Learning Unified Long-Term and Short-Term Memory" (arXiv 2601.01885, 2026-01)
- "Memory for Autonomous LLM Agents: Mechanisms, Survey" (arXiv 2603.07670, 2026-03)
- "Tool Selection Optimization for LLM Agents at Scale" (2026-01)
- Anthropic Context Engineering (2025 AWS re:Invent)
- Yao et al. "ReAct" (ICLR 2023)
- Shinn et al. "Reflexion" (NeurIPS 2023)
- OctoTools (ACL 2026) — 系统型论文写作范式参照
