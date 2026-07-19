# Changelog

## 2026-07-19

- AppWorld adapter 0.2.0：补全非 spotify app 的 oracle memory。
- 新增 `supervisor_full_profile`：从 task-level supervisor patch 抽取档案、账号密码、地址、支付卡。
- 新增通用 `app_user_library:{app}`：自动适配 users 表 schema，扫描所有 user_id 表，抽取库摘要。
- spotify 保留 genre-aware 专用逻辑，其他 app 走通用方案。
- split 自动标注：从 `datasets/*.txt` 读 taskId → split 映射，不依赖 manifest。
- schema 清理：`AgentTrajectory.result` 统一用 `error`，移除 `reason`。
- 新增 `sample_5`：5 个代表性 A 批任务（spotify/venmo/file_system/multi_app/pub_empty）。
- sample_5 跑通 stub 验证：40 runs，多 app 任务 canonical task 全部合法。
- 重写 `exp.md`：统一 RQ 格式，B 批定位为 RQ2 test 评测集。

## 2026-07-18

- RQ1 真实 executor：驱动 AppWorld REST API server，持久化 DB 改动，调官方 evaluator。
- 新增 `Executor` / `ToolExecutor` 接口，与原 4 接口同层。
- AppWorld executor 模块：http、stub_agent、server、python runner、组合层。
- stub agent 第一版：看 `usesOracleMemory` flag 推答案，受控实验设计。
- CLI 加 `rq1:run`。
- 2-task sample 跑通 RQ1 真实闭环：16 trajectory，8/16 成功。
- 归因矩阵符合预期：oracle_memory condition 全成功，其余全失败 → memory 是可恢复失败源。

## 2026-07-15

- 初始化 pnpm monorepo：schemas、data、log、session、common、prologue、experiments、cli。
- 定义核心 schema：CanonicalTask、MemoryItem、ToolItem、EvaluatorSpec、DatasetManifest、VerifierExample、LogEvent、SessionFile、AgentTrajectory。
- 下载 AppWorld 数据，创建 2-task dev 样本。
- 实现 AppWorldAdapter，收紧 memory 规则（移除 evaluator/test/metadata 泄漏）。
- Spotify 库摘要：song/album/playlist 展开，含 genre-aware 排序。
- memory distractor：同域错用户 + 跨域 app state。
- RQ1 八种 oracle condition + mock runner。
- 2-task sample 跑通 RQ1 mock 闭环：16 trajectory。
