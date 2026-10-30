# RSI-Agent 运维手册

部署与运维文档，不是 Agent 提示词。入口 `rsi/src/main.ts`、`rsi/src/worker-main.ts`，CLI `rsi/bin/rsi.mjs`。

## 安装与启动

Docker 须允许 user/mount namespace、bwrap，且 `fs.protected_hardlinks=1`、`fs.protected_symlinks=1`。镜像为 Node 22.19/Pi SDK 1.4.0。

```sh
cd rsi
cp deploy/rsi.env.example .env
# 将 RSI_SYSTEM_PROMPT_FILE 设为 rsi/system-prompt.txt 的宿主绝对路径，
# 在 .env 中设置 CLINE_API_KEY；不要提交 .env。
docker compose build
docker compose up -d
```

`RSI_SYSTEM_PROMPT_FILE` 必须是宿主绝对路径、非空普通文件；缺失、空、符号链接或硬链接即失败。`rsi-data` 保存工作区、插件、Memory、Pi 会话；`rsi-state` 保存睡眠、读取统计、候选/LKG、恢复日志和健康状态。Supervisor 以容器 root 经 `setpriv` 以 Worker uid/gid 10002 启动 bwrap；Compose 丢弃全部能力后只加 `SETUID`、`SETGID`、`CHOWN`。不要加 `privileged`、`docker.sock`、宿主根或宿主 PID namespace。

## 预检

`rsi --check`、容器 entrypoint 的 `deployment-preflight.mjs`、launcher 前置检查共用 `src/sandbox/preflight.ts` 的同一严格报告；各进程重跑而不信任缓存。要求 Linux、非 setuid bwrap 且支持 `--seccomp FD`、root Supervisor 能切换到独立非 root Worker 主机 uid/gid，并使用同一 `setpriv --reuid --regid --clear-groups`（或 spawn uid/gid）启动。真实 probe 从沙箱外读 `/proc/<pid>/status` 核对 host uid/gid，同时核对 namespace uid/gid、补充组已清除、`CapEff=0`、PID/user/mount namespace 不同、`/` 与 proc mount、UTS hostname、`fs.protected_hardlinks=1`、`fs.protected_symlinks=1`。缺项、超时、解析失败或不一致即失败关闭；无未沙箱回退或弱检查。直接检查用 `node src/main.ts --check`，需设置 `RSI_CONFIG_PATH`。

本地回归：`cd rsi && npm run check`（类型、串行测试、插件加载）。无 bwrap/Docker 时目标仍会失败。

## 生产入口验收

有界、无付费 API。用镜像默认 ENTRYPOINT，不覆盖为 node：

```sh
cd rsi
node scripts/linux-validation.mjs --mode docker --suite entrypoint \
  --image rsi-agent:local --no-build --timeout-ms 900000 \
  --report .artifacts/entrypoint.json
```

该 suite 测试真实入口、Supervisor、bwrap、Pi Worker，并用 mock provider 验证 seed、Memory、sleep 和重启。旧 `--suite target` 是调试 harness，不是入口证据。24h soak 须显式运行；CI 不执行。

无 Linux/Docker/WSL 的宿主只能给出 `blocked_environment`，不能把 YAML、脚本语法或本地 skip 当成目标通过。

## 配置与状态

新卷加载 `rsi/deploy/cline.models.json`；现有 Pi 配置不覆盖。配置、迁移、搜索与 OKX 模拟盘说明见 `rsi/SETUP.txt`。Worker 可读取自身凭据；绝不可提供实盘密钥。时区须 IANA。`/data/pi-agent` 的 settings/models/auth 为 operator 所有、Worker 只读，每次启动按 state 基线校验；合法变更须停机更新基线。fresh 卷 seed 内置 Markdown 且 index 一致，自定义 index 不覆盖。

## 健康、睡眠与重启

健康检查读 `/state/runtime/health.json`：须新鲜（默认 45 秒）、Supervisor 存活、Worker `healthy` 且进程存在，或 `sleeping` 且截止未过；`suspect/rollback` 不健康。显式 sleep 唯一暂停循环，deadline 在 `rsi-state` 重启保留；SIGTERM 正常终止，20 秒后 SIGKILL；日志每 30 秒按 16 MiB 保留 4 份轮转。

## 资源刷新、三轮晋升与回滚

控制只经状态卷 Unix socket，不暴露 TCP：

```sh
docker compose exec rsi /opt/rsi/scripts/container-control.sh status
docker compose exec rsi /opt/rsi/scripts/container-control.sh reload --reason manual
```

1. 空候选：不加载 `/data/plugins` 中的 Pi extension；带插件源记录的旧 LKG 须迁移。
2. Agent 只能用 `pi mcp`；Skill 写入原生发现目录。回合结束自动校验刷新，每类最多 5 个。
3. 静态与 3 秒 Mock 检查后，Worker 调用 `session.reload`，重读固定插件、Skill 与 MCP。
4. 连续 3 个健康 `agent_settled` 才写 LKG。
5. Watchdog 异常时重启并恢复 LKG；LKG 不含 `mcp.json`，错误配置须另行修复。

## 备份与定位

停机后成对备份两个卷，恢复保持同代和 Worker uid/gid。定位顺序：`docker compose ps`、`health.json`、preflight、`/state/logs`、Watchdog/插件状态。上述问题均失败关闭，不要放宽沙箱。
