// codex-strip-proxy.js
// 轻量转接层：跑在 codex-as-api 桥前面，剥掉 Codex OAuth 不支持的参数后透传。
// 监听 0.0.0.0:18081，上游桥 http://127.0.0.1:18080
// 用法：node codex-strip-proxy.js
'use strict';

const http = require('http');
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 18080;
const LISTEN_PORT = parseInt(process.env.STRIP_PROXY_PORT || '18081', 10);
const LISTEN_HOST = process.env.STRIP_PROXY_HOST || '0.0.0.0';

// 需要从请求体 JSON 顶层剥掉的字段（Codex OAuth 传输层不支持）
// 来源：codex-as-api 0.7.0 dist/cli.js 的 UNSUPPORTED_GENERATION_FIELDS（5442 行）
//       + 单独拒绝的 max_tokens / max_completion_tokens / temperature / stop
const STRIP_FIELDS = [
  // 单独 throw 的四个
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'stop',
  // UNSUPPORTED_GENERATION_FIELDS 全量
  'top_p',
  'top_k',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'n',
  'response_format',
  'stream_options',
  'modalities',
  'audio',
  'prediction',
  'web_search_options',
  'store',
  'metadata',
  'user',
  'quality',
  'style',
  'background',
  'moderation',
  'output_compression',
  'safety_identifier',
  'prompt_cache_options',
  'multi_agent',
  'programmatic_tool_calling',
];

function stripParams(body) {
  let obj;
  try {
    obj = JSON.parse(body);
  } catch (e) {
    return body; // 非 JSON（不太可能），原样透传
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const f of STRIP_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(obj, f)) {
        delete obj[f];
      }
    }
  }
  return JSON.stringify(obj);
}

const server = http.createServer((req, res) => {
  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);
    const body = stripParams(rawBody.toString('utf8'));

    const upstreamReq = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
          'content-length': Buffer.byteLength(body),
        },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'strip-proxy upstream error: ' + err.message } }));
    });

    if (rawBody.length > 0) {
      upstreamReq.write(body);
    }
    upstreamReq.end();
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`codex-strip-proxy listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
