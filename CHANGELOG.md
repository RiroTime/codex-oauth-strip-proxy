# Changelog

本项目的所有重要变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-09-27

首个版本。

### 新增

- `codex-strip-proxy.js`：单文件、零第三方依赖的转接层，跑在 `codex-as-api` 桥前面，
  把 Codex OAuth 传输层不支持的请求字段从 JSON 顶层剥掉再透传。
- 支持 SSE 流式透传（响应原样回传，逐字节不缓冲）。
- 全量黑名单共 **31 个字段**，来自 `codex-as-api` 0.7.0 的两处源码定义：
  - 单独拒绝的 4 个：`max_tokens`、`max_completion_tokens`、`temperature`、`stop`
  - `UNSUPPORTED_GENERATION_FIELDS` 的 27 个（`dist/cli.js:5442`）
- 环境变量 `STRIP_PROXY_HOST` / `STRIP_PROXY_PORT`。
- 部署方式三种：Node 直跑、Docker、docker compose。
- `docs/stripped-fields.md`：31 个字段清单、桥内行号、豁免机制真相，
  以及从新版桥重新提取清单的 grep 命令。
- `scripts/start-codex-bridge.sh`：一条命令同时拉起桥（18080）与转接层（18081）并做健康检查。

### 设计取舍

- **不改桥一个字节**。补丁打在独立进程上，桥升级时本层不受影响；
  代价是多一跳进程，以及需要自己维护字段清单。
- **剥字段而非透传**：桥对不认识的字段是「报 400」而不是「忽略」，
  所以只能删除，不能原样转发。
- **不新增字段白名单**：桥拒绝的是「不支持」，不是「未识别」，
  转发任何额外字段都可能被拒；只保留标准对话必需字段最安全。

### 已知限制

- 被剥掉的字段静默失效。客户端界面里的温度 / 最大 token 设置不生效 ——
  这是 Codex OAuth 通道的固有属性，本层只把「400 报错」降级为「优雅忽略」。
- 上游是私有接口，OpenAI 可能随时调整协议。
- 桥自身锁定其发布时验证过的 client version，部分新模型可能暂时不可见（与本层无关）。
