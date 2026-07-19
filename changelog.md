# Changelog

## 2026-07-19

- AppWorld adapter 0.2.0：补全非 spotify app 的 oracle memory。
- 新增 `supervisor_full_profile`：从 task-level supervisor.jsonl 抽取档案、account_passwords、地址、支付卡。
- 新增通用 `app_user_library:{app}`：自动适配 users 表 schema，扫描 user_id 关联表。
- 修复 split 自动标注：按 taskId 实际归属标注，不再信任 manifest 字段。
- schema 清理：移除 `AgentTrajectory.result.reason`，统一用 `error`。
- 新增 `sample_5`：5 个代表性 A 批任务，stub 验证 40 runs 通过。
- 重写 `exp.md`：统一 RQ 格式，B 批定位为 RQ2 test 评测集。

## 2026-07-18

- 实现 RQ1 真实 executor：驱动 AppWorld REST API → 持久化 DB → 调官方 evaluate_task。
- 新增 AppWorld executor 模块（http / stub_agent / server / python / 组合）。
- stub agent 未接 LLM：按 usesOracleMemory flag 推答案，受控实验。
- CLI 加 `rq1:run`，路径相对 INIT_CWD 解析。
- 修复 AppWorld initialize / URL 前缀 / evaluator 路径误判三个 bug。
- 2-task sample 跑通 RQ1 真实闭环：16 trajectory，8/16 成功，归因矩阵符合预期。

## 2026-07-15

- 初始化 pnpm monorepo：schemas / data / log / session / common / prologue / experiments / cli。
- 定义核心 schema：CanonicalTask、MemoryItem、ToolItem、EvaluatorSpec、DatasetManifest、VerifierExample、LogEvent、SessionFile、AgentTrajectory。
- 下载 AppWorld 数据，创建 dev split 最小样本。
- 实现 AppWorldAdapter，收紧 memory 规则（移除 evaluator 泄漏）。
- Spotify 库摘要：song / album / playlist 展开 + 同域错用户 + 跨域 app 干扰。
- 实现 RQ1 八种 oracle condition 与 mock runner，2-task sample 跑通 16 trajectory。
