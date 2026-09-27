#!/bin/sh
# 一键拉起 codex-as-api 桥 + strip-proxy 转接层
# 用法：docker exec <桥所在容器> sh /path/to/start-codex-bridge.sh
# 说明：桥监听 18080（客户端用该容器的内网 IP:18080 访问），转接层监听 18081（推荐让客户端配这个）。
# 注意：若桥与客户端不在同一 Docker 网络，需先让它们互通（跨网络用 docker network connect）。

# 杀旧进程（[c]/[s] 方括号防止 pkill 匹配自身命令行）
pkill -f "[c]odex-as-api" 2>/dev/null
pkill -f "[c]odex-strip-proxy" 2>/dev/null
sleep 1

# 转接层脚本路径：默认取本脚本所在目录，可用 CODE_STRIP_JS 环境变量覆盖
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CODE_STRIP_JS="${CODE_STRIP_JS:-$SCRIPT_DIR/../codex-strip-proxy.js}"

# 1. 起桥（CODEX_AS_API_MODEL 按订阅目录内的 slug 填）
CODEX_AS_API_HOST=0.0.0.0 \
CODEX_AS_API_PORT=18080 \
CODEX_AS_API_MODEL="${CODEX_AS_API_MODEL:-gpt-6-astra}" \
nohup codex-as-api > /tmp/codex-as-api.log 2>&1 &

# 2. 起转接层（剥掉上游不支持的参数，客户端配这个端口）
STRIP_PROXY_HOST=0.0.0.0 \
STRIP_PROXY_PORT=18081 \
nohup node "$CODE_STRIP_JS" > /tmp/strip-proxy.log 2>&1 &

sleep 5

echo "== bridge health (18080) =="
curl -s -m 8 http://127.0.0.1:18080/health
echo
echo "== strip-proxy health (18081) =="
curl -s -m 8 http://127.0.0.1:18081/health
echo
