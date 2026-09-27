# 部署与网络拓扑 / Deployment

本文件是 README「上游地址与网络拓扑」一节的展开：三种拓扑的完整命令、验证方法、排查顺序，
以及几个踩过就会记得的坑。

## 一、唯一的硬约束

转接层连上游桥的地址，**不是环境变量，而是脚本顶部的两个常量**：

```js
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 18080;
```

所以配置面极小 —— 能改的只有「自己监听在哪」（`STRIP_PROXY_HOST` / `STRIP_PROXY_PORT`），
**不能改上游在哪**。要改上游地址，就改脚本。

由此推出一条硬约束：

> **转接层进程和桥，必须共享同一个 `127.0.0.1`。**

`127.0.0.1` 不是「网络上的某个地址」，它就是「我自己这台机器」。所以这句话翻译过来是：
**两个进程得在同一台机器、同一个网络命名空间里。** 剩下三种拓扑，无非是在满足这一条。

## 二、三种拓扑

### 拓扑 A：都在宿主机上直跑

最简单，天然满足约束。

```bash
# 1) 起桥（它自己的监听地址由它自己的变量决定）
CODEX_AS_API_HOST=0.0.0.0 CODEX_AS_API_PORT=18080 codex-as-api &

# 2) 起转接层
node codex-strip-proxy.js &
```

### 拓扑 B：转接层在 Docker，桥在宿主机

用 host 网络 —— 容器此时不再有独立的网络命名空间，容器里的 `127.0.0.1` 就是宿主机的 `127.0.0.1`。

```bash
docker run -d --name strip-proxy --network host codex-oauth-strip-proxy
```

compose 里则写：

```yaml
network_mode: host
```

⚠️ **host 网络只在 Linux 上生效。** macOS / Windows 的 Docker Desktop 跑在虚拟机里，
`--network host` 并不会让容器共享宿主机网络。这两条路请改用端口映射，
并把脚本里的 `UPSTREAM_HOST` 改成 `host.docker.internal`：

```bash
docker run -d --name strip-proxy \
  -p 18081:18081 \
  --add-host=host.docker.internal:host-gateway \
  codex-oauth-strip-proxy
# 并修改 codex-strip-proxy.js: const UPSTREAM_HOST = 'host.docker.internal';
```

### 拓扑 C：桥也在容器里

两个容器放进**同一个自定义 network**，然后把 `UPSTREAM_HOST` 改成桥的**容器名**，
靠 Docker 内置 DNS 互相解析。

```bash
docker network create codex-net
docker run -d --name codex-bridge --network codex-net <桥的镜像>
docker run -d --name strip-proxy --network codex-net codex-oauth-strip-proxy
# 并修改 codex-strip-proxy.js: const UPSTREAM_HOST = 'codex-bridge';
```

## 三、怎么确认真的通了

分三步，**顺序不要换** —— 每一步排除一类原因。

**第 1 步：转接层端口活着吗**

```bash
curl -s -m 8 http://127.0.0.1:18081/health
```

注意：**转接层自己不实现任何路由**，它把所有请求原样转发给桥。所以问 `18081/health`，
拿到的其实是**桥**的回答。这一步通过只证明「转接层 → 桥」这一段通的，不证明剥字段逻辑对。

**第 2 步：剥字段真的生效了吗（决定性测试）**

同一个请求打两个端口，看结果差：

```bash
# 直接打桥：应当 400，错误里出现 is not supported
curl -s -m 20 http://127.0.0.1:18080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<订阅目录内的 slug>","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'

# 打转接层：应当 200
curl -s -m 20 http://127.0.0.1:18081/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<订阅目录内的 slug>","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'
```

**一个 400、一个 200，才说明剥字段在干活。** 两个都 400 = 字段没剥干净；
两个都 200 = 你其实在直接打桥（检查客户端配的端口）。

**第 3 步：流式也要单独测**

SSE 走的是另一条响应路径，非流式通了不代表流式通：

```bash
curl -N -s -m 30 http://127.0.0.1:18081/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<slug>","messages":[{"role":"user","content":"hi"}],"stream":true,"stream_options":{"include_usage":true}}'
```

应当看到逐行 `data: {...}` 帧正常吐出。`stream_options` 是被桥拒的字段之一，
所以这个请求能过，说明剥除逻辑覆盖到了名单类字段。

## 四、排查顺序

按这个顺序走，每一步只排除一类原因，别跳：

1. **`curl 18081/health` 不通** → 端口/进程问题（拓扑 A 或 B 没起对）。
   - 看端口有没有被占：`ss -ltnp | grep 18081`
   - 看进程还在不在：`pgrep -af strip-proxy`
2. **18081 通、18080 不通** → 桥没起，和本代理无关。
3. **两个都通，但请求 400 且消息含 `is not supported`** → 字段没剥干净，
   桥可能升级后加了新字段。按 [`stripped-fields.md`](stripped-fields.md) 第四节重新提取清单。
4. **`Connection refused` 或 502** → 拓扑问题。转接层连不到 `127.0.0.1:18080`，
   回到第一节确认两个进程是否真的共享同一个 `127.0.0.1`。
5. **`model_not_found`** → 和本代理无关，是模型名不在你订阅目录内。

## 五、几个坑

- **`--add-host=host.docker.internal:host-gateway` 单独加没用**。
  脚本里连的是 `127.0.0.1`，而 `host.docker.internal` 是另一个主机名 —— 名字对不上就解析不到。
  要么用 host 网络，要么同时改 `UPSTREAM_HOST`。
- **`127.0.0.1` 在容器里不等于宿主机**（除非用了 host 网络）。这是这一层最常见的部署事故。
- **`nohup ... &` 起的进程，容器重启就没了**。它不是服务，不会被 SDK 或 init 拉起。
  换建议：写成 compose 的一个 service，或者把启动命令塞进容器启动脚本。
- **改完脚本记得重启进程**。改的是文件，不是运行中的进程：
  `pkill -f "[c]odex-strip-proxy"` 后再 `node codex-strip-proxy.js`。
  方括号是为了让 `pkill -f` 不匹配到自己的命令行。

## 六、容器化部署的三个进阶坑

前三节够跑通常规拓扑；这一节是**容器环境里真会绊住人的地方**，都由实测踩出来。

### 坑一：把服务发布到宿主机 IP，别的容器访问不了

很自然的想法：把桥用 `-p` 发布到宿主机 IP，再让客户端容器去访问 `<宿主机IP>:18081`。
**这条路在 Docker 里走不通。**

同一个容器里实测：

| 目标 | 结果 |
|---|---|
| `curl http://<宿主机IP>:18081/health` | **连接超时**（`code=000`） |
| `curl http://<桥容器IP>:18081/health` | **200** |

原因：`-p <宿主机IP>:<端口>:<端口>` 生成的 DNAT 规则挂在 `nat/DOCKER` 链上，
而 Docker 会为每个 bridge 加一条「**从该 bridge 进来的流量直接 RETURN**」的规则（避免转发回环）。
于是**容器发往宿主机 IP 的包不会命中 DNAT**；宿主机自己 curl 走的是 `nat/OUTPUT`，所以它是通的。

> **结论：在宿主机上测通 ≠ 容器能通。凡是连通性结论，必须从「调用方那一侧」测出来。**

### 坑二：跨网络互访 —— 用「转发网关容器」，不要靠 `docker network connect`

客户端和桥分处两个 compose 项目的网络时（互相隔离、默认不转发），有个常见做法是手工
`docker network connect` 把容器接进对方网络。**能用，但很脆**：

`docker network connect` 属于**带外状态** —— 不在任何 compose 文件里。任何一次
`compose up` 重建该容器，这条连接**会静默消失**：容器照样 `Up`，只是连不上，**不报错**。

推荐做法：起一个**只做 L4 转发的网关容器**，同时接入两张网络，**两端都用容器名寻址**：

```yaml
services:
  gateway:
    image: nginx:latest          # 官方镜像自带 --with-stream，无需另拉镜像
    container_name: gateway
    restart: unless-stopped
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    networks:
      - client_net               # 面向调用方
      - bridge_net               # 面向桥

networks:
  client_net:
    external: true
  bridge_net:
    external: true
```

```nginx
stream {
    access_log off;
    server {
        listen 18081;
        proxy_pass <桥容器名>:18081;
        proxy_connect_timeout 5s;
        proxy_timeout 1800s;      # 给流式回答留足空闲窗口
    }
}
```

三个好处：

1. **两端都用容器名**（不是 IP）—— 容器重建换了 IP 也不怕；
2. **不重建任何现有容器**，被调方一个字节不动；
3. 网关自己 `restart: unless-stopped`，宿主机重启后自动回来。

Docker 内置 DNS 的规则很简单：**接在同一张用户自定义网络上的容器，能用容器名互相解析**
（默认的 `bridge` 网络不支持）。名字对不上时报错是 `Could not resolve host`，
而「能解析但连不上」是超时 —— 两种错要分清。

### 坑三：让进程随容器自启时，小心「重建会丢掉文件」

容器里的进程如果是人工 `nohup` 起的，容器重启后不会自己回来。正确做法是写进容器的 entrypoint
—— 但**改 entrypoint 有个陷阱**：

- **`docker compose up -d` 是「拆旧造新」**：容器的**可写层会清空**。所有不在挂载卷里的文件
  （你 `docker cp` 进去的东西、手工 `npm i -g` 装的包）**统统消失**。
- **`docker restart` 是「原地重启」**：可写层保留。

所以，如果那几个文件正好在可写层里（很常见），**必须先把它们备份到持久目录**，再谈自启。
最小步骤：

```sh
# 1) 备份原版 entrypoint + 要自启的文件
docker cp <容器>:/usr/local/bin/<entrypoint>   /backup/entrypoint.original
docker cp <容器>:/path/to/<your-script.js>     /backup/
docker cp <容器>:/usr/local/lib/node_modules/<包名> /backup/   # npm 全局包要拷整目录

# 2) 本地改好塞回去（目标已存在 ⇒ docker cp 保留原权限，不必 chmod）
sh -n new-entrypoint.sh                       # 先语法检查，再动手
docker cp new-entrypoint.sh <容器>:/usr/local/bin/<entrypoint>

# 3) 只重启，不重建
docker restart <容器>
```

三条纪律：

1. **原内容逐字别动**，只在末尾 `exec ...` **之前**插入；
2. 插入段用 `[ -x ]` / `[ -f ]` 包住，可能失败的命令加 `|| true` ——
   脚本头若有 `set -eu`，一条失败命令就会让入口整体退出、**容器起不来**；
3. 日志**别写 `/tmp`**（tmpfs，重启即失），写进挂载卷。

**验证**：`docker top <容器>` 确认目标进程确实**由 entrypoint 自己拉起**（PID 紧邻 init 进程），
再从**调用方容器内**打一次真实业务接口。只看「容器 Up」不算通过。

> 另外：如果 entrypoint 是**从宿主机文件 build 进镜像**的，改完容器里的那份之后，
> **宿主机上的源文件也要同步改** —— 否则将来 `compose up --build` 会拿镜像里的旧版把改动盖回去。
