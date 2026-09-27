# codex-oauth-strip-proxy

> 让严格的 OpenAI 兼容客户端（如 **Dify**）能用上 `codex-as-api` 桥 —— 一个几乎无依赖的轻量转接层。
>
> A tiny sidecar that strips the parameters the private ChatGPT/Codex OAuth transport rejects, so strict OpenAI-compatible clients can talk to a [`codex-as-api`](https://github.com/Eunho-J/codex-as-api) bridge.

---

## 背景：为什么要这一层

`codex-as-api` 把 **ChatGPT 订阅**的 Codex OAuth 通道封装成 OpenAI 兼容接口 —— 不需要 API key，额度记在订阅上。但它对请求参数**极其严格**：只要出现它不支持的字位，就直接返回 `400`，而不是静默忽略。

被它拒绝的字段有三类：

| 类型 | 字段 |
|---|---|
| 单独拒绝 | `max_tokens`、`max_completion_tokens`、`temperature`、`stop` |
| 名单拒绝（`UNSUPPORTED_GENERATION_FIELDS`） | `top_p`、`top_k`、`frequency_penalty`、`presence_penalty`、`seed`、`logprobs`、`top_logprobs`、`logit_bias`、`n`、`response_format`、`stream_options`、`modalities`、`audio`、`prediction`、`web_search_options`、`store`、`metadata`、`user`、`quality`、`style`、`background`、`moderation`、`output_compression`、`safety_identifier`、`prompt_cache_options`、`multi_agent`、`programmatic_tool_calling` |

而很多标准客户端偏偏会固定发送这些字段。以 **Dify 官方 OpenAI 插件**为例：

- **验证凭据**时硬编码发送 `max_tokens: 20`（插件源码 `models/llm/llm.py`）；
- **流式对话**时固定附加 `stream_options: {"include_usage": true}`（插件源码 `models/llm/chat.py`）。

于是 Dify 侧无论如何配置都过不了桥，报 `400 invalid_request_error`。

而 `codex-as-api` 唯一的内置豁免通道只对 **Claude Code 会话**生效（`ignoreMaxTokens: claudeCodeSessionId != null`），普通客户端既无开关也无环境变量。

## 方案：剥参数，不改桥

在客户端与桥之间加一层极小的 sidecar —— 把黑名单字段从请求 JSON **顶层剥掉**再转发，响应（含 SSE 流式）原样回传。

```
客户端 (Dify / 任意 OpenAI 兼容客户端)
   │  POST /v1/chat/completions  (带 max_tokens / temperature / stream_options …)
   ▼
codex-oauth-strip-proxy  :18081        ← 本仓库（剥掉黑名单字段）
   │
   ▼
codex-as-api             :18080        ← 原样使用，一个字节不改
   │
   ▼
chatgpt.com/backend-api/codex          ← 私有 OAuth 通道，额度走 ChatGPT 订阅
```

**不修改 `codex-as-api` 任何代码** —— 因此桥升级时本代理不受影响，只需维护这一层。

## 快速开始

### 方式一：Node 直跑（零依赖，仅用内置 `http`）

```bash
node codex-strip-proxy.js
# codex-strip-proxy listening on 0.0.0.0:18081 -> 127.0.0.1:18080
```

要求 Node ≥ 18。

### 方式二：Docker

```bash
docker build -t codex-oauth-strip-proxy .
docker run -d --name strip-proxy \
  --network host \
  codex-oauth-strip-proxy
```

### 方式三：docker compose

```bash
cp .env.example .env      # 可选，全部变量都有默认值
docker compose up -d
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `STRIP_PROXY_HOST` | `0.0.0.0` | 监听地址 |
| `STRIP_PROXY_PORT` | `18081` | 监听端口 |

## 上游地址与网络拓扑（Docker 必读）

上游桥的地址**不是环境变量**，而是脚本顶部的两个常量：

```js
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 18080;
```

这意味着**本进程必须和桥处于同一个网络命名空间**，所以：

- **裸机 / NAS 直跑** —— 天然满足，无需任何额外配置。
- **Docker** —— 用 host 网络。容器里的 `127.0.0.1:18080` 就是宿主机的 `127.0.0.1:18080`。
  用 `--network host` 或 compose 里的 `network_mode: host`。
  ⚠️ 注意 host 网络**只在 Linux 上生效**；macOS / Windows 的 Docker Desktop 请改用端口映射，
  并把脚本里的 `UPSTREAM_HOST` 改成 `host.docker.internal`。
- **桥也在容器里** —— 把两个容器放进同一个自定义 network，
  把 `UPSTREAM_HOST` 改成桥的**容器名**，用容器名互相解析。

> 不要试图用 `--add-host=host.docker.internal:host-gateway` 绕过：脚本里写死的是 `127.0.0.1`，
> `host.docker.internal` 是另一个主机名，解析不到就白加。

## 客户端配置（以 Dify 为例）

1. **设置 → 模型供应商 → OpenAI → 添加凭据**
2. **API Key**：任意值（桥不校验，例如 `dummy`）
3. **API Base URL**：`http://<host>:18081/v1` —— **结尾必须带 `/v1`**
4. **API 协议**：**Chat Completions** —— 不要选 Responses（桥没有 `/responses` 端点）
5. **验证模型**：`gpt-6-astra`（或订阅目录内的任一模型）
6. 保存通过后，在供应商下**添加自定义模型**，模型名必须是订阅目录内的 slug

## 支持的模型

模型可用性由 **ChatGPT 订阅目录**决定（服务端按账号下发），本代理不做限制。以桥容器内 `models_cache.json` 为准，常见：

```
gpt-6-astra   gpt-5.6-sol   gpt-5.6-terra   gpt-5.6-luna   gpt-5.5
```

不在目录内的名字（如 `gpt-5.5-pro`、裸 `gpt-5.6`、`chat-latest`、带日期的变体）会得到：

```json
{"error":{"message":"requested model is not available in the authenticated upstream catalog",
          "type":"model_not_found","code":"model_not_found"}}
```

> 注意：客户端 UI 里「能选中」只代表插件认识这个名字，**不代表上游可用**。

## 已知限制

- **被剥掉的字段不会生效**：例如 Dify 界面里的「温度」「最大 token」设置会被静默忽略。这是 Codex OAuth 通道的固有属性，本代理不改变模型行为，只把「报错 400」降级为「优雅忽略」。
- **上游是私有接口**：OpenAI 可能随时调整协议，本代理只负责参数剥离，不解决上游变动。
- **桥会锁定其发布时验证过的 Client Version**：因此部分新模型可能暂时不可见（与本代理无关）。

## 维护

- 本代理**无第三方依赖**，Node ≥ 18 即可运行；代码单文件、约 110 行。
- 若上游新增被拒字段：在 `STRIP_FIELDS` 数组里追加即可。字段清单与再提取方法见 [`docs/stripped-fields.md`](docs/stripped-fields.md)。
- 桥升级不需要改动本代理；反之亦然。

## 仓库结构

```
codex-oauth-strip-proxy/
├── codex-strip-proxy.js      # 全部逻辑，单文件 ~110 行，零依赖
├── Dockerfile                # node:20-alpine，含端口存活健康检查
├── docker-compose.yml        # host 网络，开箱即用
├── .env.example              # 环境变量示例（全部有默认值）
├── .dockerignore
├── package.json
├── scripts/
│   └── start-codex-bridge.sh # 桥 + 转接层一键拉起（含健康检查）
├── docs/
│   └── stripped-fields.md    # 31 个被剥字段清单 + 再提取方法
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## 姊妹项目

- [`codex-as-api`](https://github.com/Eunho-J/codex-as-api) —— 把 ChatGPT/Codex OAuth 暴露为 OpenAI 兼容接口的桥（本代理的上游）。

## License

MIT © RiroTime
