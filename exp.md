# 实验主逻辑

## 总论点

agent 的大量失败发生在执行之前：意图、记忆、工具没有被正确构建。
如果把执行前上下文构建显式化，并用可训练 verifier 判断其充分性，就能在固定预算下稳定提升 agent 成功率。

四个 RQ 是一条递进证据链，不是并列实验。

```
RQ1  问题是否存在      →  RQ2  方法能否解决      →  RQ3  机制是否可靠      →  RQ4  结论是否泛化
失败可归因                Prologue 有效             Verifier 可学习            跨 benchmark 成立
```

---

## RQ1：失败是否来自执行前上下文选择错误？

**作用**：problem evidence。没有 RQ1，Prologue 只是设计偏好；有了 RQ1，论文有因果动机。

**要证明**：正确记忆和工具都在候选池里，但 agent 没选对。用 oracle 替换某组件后失败能否恢复。

- 能恢复 → 失败来自执行前上下文构建错误
- 不能恢复 → 失败来自执行阶段能力不足

**实验**：8 个 condition 组合消融。

```
baseline     x + M + T
oracle_I     x + I* + M + T
oracle_M     x + M* + T
oracle_T     x + M + T*
oracle_I+M   x + I* + M* + T
oracle_I+T   x + I* + M + T*
oracle_M+T   x + M* + T*
oracle_all   x + I* + M* + T*
```

**指标**：各 condition 成功率提升、边际贡献、交互项、失败归因比例。

**预期**：失败任务中 40%-60% 可由 oracle 替换恢复；intent / memory / tool 各占不同比例并存在交互。

**数据**：A 批（train+dev，147 个，oracle 完整）。

---

## RQ2：Context Prologue 能否自动减少这些失败？

**作用**：method evidence。RQ1 用 oracle 证明"上下文对了任务能成功"；RQ2 证明不靠 oracle、只用 Prologue 自动构建 `(i, m, t)` 也能减少失败。

**要证明**：提升不是单点组件收益，而是三组件联合 + 充分性检查的系统收益。

**实验**：6 个方法对比。

```
直接执行（ReAct / Reflexion）
Planner-Executor
只做 intent
只做 memory
只做 tool
执行中交错调用
Context Prologue（全部）
```

**控制**：同模型、同总 token 预算、同工具库、同记忆库。

**指标**：任务成功率、token 效率、工具调用次数、延迟。

**数据**：
- A 批（train+dev）：跑含 oracle condition 的主对比
- B 批（test_normal + test_challenge，585 个）：只跑 baseline vs Context Prologue 的端到端评测，证明提升不靠 ground truth 泄漏

**预期**：Prologue 在三个主数据集上显著提升成功率；固定预算下同时提升 token 效率；三组件联合优于任意子集。

---

## RQ3：Sufficiency Verifier 是否是可靠核心？

**作用**：mechanism evidence。决定论文是 prompt pipeline 还是可学习的上下文充分性框架。

**要证明**：context sufficiency 可学习，verifier 能判断、定位、修复上下文不足。

### RQ3.1 能否预测任务成功？

```
V(x, z) → P(success)，z = (i, m, t)
```

**指标**：ROC AUC、PR AUC、校准误差、False Sufficient Rate、与成功率相关性。

### RQ3.2 能否定位缺失来源？

```
V(x, z) → missing ∈ {intent, memory, tool, multiple, none}
```

**标签来源**：oracle 替换实验——单组件替换后由失败转成功，则该组件为缺失来源。

**指标**：Missing Type Accuracy、分项准确率、与 oracle attribution 的一致性。

### RQ3.3 能否指导修复？

```
score < τ  →  根据 missing 修复对应组件  →  再验证
score ≥ τ  →  冻结上下文并执行
```

**对比**：无 verifier 直接执行 / 无 verifier 固定轮数 Prologue / LLM-as-Verifier / 可训练 verifier / Oracle verifier。

**指标**：修复后成功率提升、平均 Prologue 轮数、token 效率、阈值 τ 与成功率关系。

**训练数据**：A 批执行轨迹，每任务构造多个 `z`，执行得 `y_success`，oracle 替换得 `y_missing`。按 task id 划分 train/dev/test。

**预期**：可训练 verifier 显著优于 LLM-as-Verifier 和固定轮数；低 FSR 下判断何时进入执行；缺失分类与 oracle attribution 高度一致；verifier 指导修复比固定轮数更高效。

---

## RQ4：方法是否能跨数据、任务、执行器泛化？

**作用**：external validity evidence。回答评审最常见质疑："是不是只适用于你构造的数据？"

**要证明**：Prologue 不是过拟合某个 benchmark 的 trick，而是 agent 执行前上下文构建的通用机制。

**实验维度**：

```
跨 benchmark    train on τ³-bench + AppWorld + MemoryAgentBench
                test  on BFCL V4 / BrowserGym / Terminal-Bench / SWE-Lancer
跨 domain       tool-use / retrieval / memory-heavy / coding / web
跨 executor     GPT-4o / Claude / Qwen 7B-32B-72B / Llama 8B-70B
跨噪声强度      memory distractor 5/20/50，tool distractor 10/50/100
```

**指标**：held-out benchmark 成功率、跨 executor 性能下降、噪声强度 vs 相对收益曲线。

**预期**：held-out benchmark 仍有稳定提升；弱执行器收益更大；噪声增加时 Prologue 优势更明显；verifier 跨 executor 下降但仍正收益。

---

## 证据链闭环

```
RQ1 诊断失败来源
      ↓
RQ3 用诊断信号训练 verifier
      ↓
RQ2 用 verifier 改善执行
      ↓
RQ4 验证泛化性
```

**论文价值**：不是"又一个 agent 框架"，而是针对 agent failure mode 的系统性框架——把失败前移到执行前、把上下文构建变成可验证对象、用 oracle attribution 作为可复用分析工具、用 verifier 连接诊断与执行。
