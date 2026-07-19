# Changelog

## 2026-07-19

- AppWorld adapter 0.1.5 → 0.2.0：补全非 spotify app 的 oracle memory。
- 新增 `supervisor_full_profile`：从 task-level supervisor.jsonl 抽取档案、账号密码、地址、支付卡。
- 新增通用 `app_user_library:{app}`：自动检测 users 表 schema,按 email/phone 定位用户,扫描所有 user_id 表。
- spotify 保留专用 genre-aware 抽取,其他 app 走通用方案。
- 修复 split 自动标注:从 datasets/*.txt 读取,不再信任 manifest 字段。
- schema 清理:`AgentTrajectory.result` 移除冗余 `reason`,统一用 `error`。
- 新增 `sample_5`:5 个代表性 A 批任务(spotify/venmo/file_system/multi_app_3/pub_empty)。
- sample_5 stub 验证通过:5 × 8 = 40 runs,adapter 在多 app 任务上全部产出合法 canonical task。
- 重写 `exp.md`:统一 RQ 格式,B 批定位为 RQ2 test 端到端评测集。

## 2026-07-18

- 实现 RQ1 真实 executor:驱动 AppWorld REST API server → 持久化 DB 改动 → 调官方 `evaluate_task`。
- 新增 `Executor` / `ToolExecutor` 接口于 `@prologue/prologue`。
- 新增 AppWorld executor 模块:http_client、stub_agent、server_manager、python_runner、组合层。
- 新增 Python 脚本 `python/appworld/{serve_apis, eval_task, init_task}.py`。
- stub agent 第一版未接真实 LLM:看 `usesOracleMemory` flag,从 oracle memory 推答案。
- CLI 加 `rq1:run` 命令;路径相对 `INIT_CWD` 解析。
- 修复 AppWorld `initialize()` 在 fresh process 的 time_freezer 报错。
- 修复 `AppWorldToolExecutor` URL 重复 app 前缀。
- 修复 evaluator 拒绝路径含 "memory" 子串:experiment_name 内 `memory→mem` 转义。
- 2-task AppWorld sample 跑通 RQ1 真实闭环:16 条 trajectory,8/16 成功。
- 归因矩阵:4 个 oracle_memory condition 全成功,4 个非 oracle_memory condition 全失败。

## 2026-07-15

- 初始化 pnpm monorepo:schemas、data、log、session、common、prologue、experiments、cli。
- 定义核心 schema:CanonicalTask、MemoryItem、ToolItem、EvaluatorSpec、DatasetManifest、VerifierExample、LogEvent、SessionFile、AgentTrajectory。
- 下载 AppWorld 数据,创建 dev split 最小样本。
- 实现 `AppWorldAdapter`,转换 AppWorld sample 为 `CanonicalTask`。
- 收紧 memory 规则:移除 evaluator/test/metadata 泄漏。
- 从 `base_dbs/spotify.db` 抽取用户库摘要,展开 song/album/playlist。
- 加入 memory distractor:同域错用户、跨域 app state。
- 实现 RQ1 八种 oracle condition 与 mock runner。
- AppWorld sample 跑通 RQ1 mock 闭环:2 个任务、16 条 trajectory。
- 初始化 Prologue git 仓库。
