# Changelog

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
