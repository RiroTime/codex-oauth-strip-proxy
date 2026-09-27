# 被剥离字段清单 / Stripped Fields

本文件说明 `codex-strip-proxy` 会从请求 JSON 顶层剥掉哪些字段，以及**如何从新版本桥里重新提取这份清单**。

## 一、当前清单（共 31 个）

来源：`codex-as-api@0.7.0` → `dist/cli.js`

### 1. 单独 throw 的字段（4 个）

| 字段 | 桥内位置 |
|---|---|
| `max_tokens` | `cli.js:2183`（条件 `opts.maxTokens != null && opts.ignoreMaxTokens !== true`） |
| `max_completion_tokens` | 同上（同一处检查，错误信息合并） |
| `temperature` | `cli.js:2188` |
| `stop` | `cli.js:2677` |

### 2. `UNSUPPORTED_GENERATION_FIELDS` 数组（27 个）

定义位置：`dist/cli.js:5442`，由 `rejectUnsupportedGenerationFeatures()`（`cli.js:7905`）统一检查。

```
top_p                top_k                 frequency_penalty
presence_penalty     seed                  logprobs
top_logprobs         logit_bias            n
response_format      stream_options        modalities
audio                prediction            web_search_options
store                metadata              user
quality              style                 background
moderation           output_compression    safety_identifier
prompt_cache_options multi_agent           programmatic_tool_calling
```

### 3. 豁免机制的真相

`cli.js:6699` 只有一处把 `ignoreMaxTokens` 置为 `true`：

```js
ignoreMaxTokens: claudeCodeSessionId != null,
```

即：**仅 Claude Code 会话被豁免**。普通客户端没有官方开关；环境变量 `CODEX_AS_API_CODEX_CLI_VERSION` 之类也帮不上忙（该变量在 0.7.0 中被显式拒绝：`the wire contract is pinned to 0.153.3`）。

## 二、如何从新版本桥重新提取清单

桥升级后，用下面两条命令重新核对（在桥所在容器内执行）：

```bash
# 1) 取数组完整定义
grep -n -A30 "var UNSUPPORTED_GENERATION_FIELDS" \
  /usr/local/lib/node_modules/codex-as-api/dist/cli.js

# 2) 列出所有「拒绝点」，含单独 throw 的字段
grep -n "is not supported by the private" \
  /usr/local/lib/node_modules/codex-as-api/dist/cli.js
```

第 2 条命令会同时输出 Anthropic 路径（`/v1/messages`）的拒绝点，例如 `stop_sequences`、`image size` —— 这些与 OpenAI 兼容路径（`/v1/chat/completions`）无关，**不需要剥**。

## 三、为什么用「剥」而不是「透传」

桥的拒绝发生在协议转换**之前**，被拒字段本来就不会进入发往 Codex 后端的载荷。因此「剥掉」=「原本就不可能生效的参数被忽略」，**不改变模型行为**，只是把 `400 报错` 降级为 `静默忽略`，让上层客户端能正常跑通。

## 四、新增字段的步骤

1. 用上面的命令重新提取清单；
2. 与 `codex-strip-proxy.js` 里的 `STRIP_FIELDS` 做差集；
3. 把新字段追加进数组（保持注释里标注来源版本）；
4. 重启代理：`pkill -f "[c]odex-strip-proxy"` 后重新 `node codex-strip-proxy.js`。

> 提示：`pkill` 的模式与被杀进程同名时，**杀进程的命令与启动命令要分两条执行**，否则 `pkill -f` 会连同自己的 shell 一起匹配掉。
