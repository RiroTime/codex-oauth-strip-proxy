FROM node:20-alpine

LABEL org.opencontainers.image.title="codex-oauth-strip-proxy" \
      org.opencontainers.image.description="Strips the parameters the private ChatGPT/Codex OAuth transport rejects, so strict OpenAI-compatible clients (e.g. Dify) can use a codex-as-api bridge." \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# 只有一个文件，没有任何依赖
COPY codex-strip-proxy.js ./

ENV STRIP_PROXY_HOST=0.0.0.0 \
    STRIP_PROXY_PORT=18081 \
    NODE_ENV=production

EXPOSE 18081

# 纯本地存活检测（只探端口）。
# 不要把 /health 当作健康检查：本层没有本地路由，/health 会被转发给上游桥，
# 那样桥没起时容器会被误判为不健康。
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD nc -z 127.0.0.1 18081 || exit 1

USER node

CMD ["node", "codex-strip-proxy.js"]
