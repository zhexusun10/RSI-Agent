# RSI-Agent 安全边界

本文说明边界，不是 Agent 系统提示词。

## 容器与 bubblewrap

外层 Docker 是部署边界，不是虚拟机。Supervisor 在 bwrap 外受信运行，负责配置、broker、外部状态、预检、LKG、Watchdog、睡眠和 Worker 生命周期；不挂 `docker.sock`、不映射宿主根。

镜像内 Supervisor 以容器 root 运行，仅为 `setpriv` 切换到独立 Worker uid/gid 10002；Compose 丢弃全部能力后只加 `SETUID`/`SETGID`/`CHOWN`。

Worker 在 bwrap 中运行 Pi SDK 和两个固定 npm 插件。bwrap 将 Pi 安装、RSI 源码、人工提示词和受管 Markdown 只读绑定，为 operator config 加只读覆盖；遮蔽 `/state`；丢弃 capability；no-new-privileges；隔离 PID/IPC/UTS 与 `/proc`。Worker 不能 remount 只读绑定、逃出 namespace 或创建嵌套 userns。

## 预检与目标证据

CLI `--check`/`--start`、容器 entrypoint 的 `deployment-preflight.mjs` 与 launcher 共用 `src/sandbox/preflight.ts` 的同一严格 probe；各进程重跑，不存在 root 第二套手写 probe 或 CLI 弱检查。要求 Linux、非 setuid bwrap 且支持 `--seccomp FD`，root Supervisor 可切换到独立非 root host Worker uid/gid。probe 从沙箱外读 `/proc/<pid>/status` 核对 host uid/gid，并核对 namespace uid/gid、补充组已清除、`CapEff=0`、PID/user/mount namespace 不同、`/` 与 proc mount、UTS hostname、`fs.protected_hardlinks=1`、`fs.protected_symlinks=1`。缺项、超时或不一致即失败关闭。

生产入口验收必须用镜像默认 ENTRYPOINT 跑 `node scripts/linux-validation.mjs --mode docker --suite entrypoint --image <image> --no-build --timeout-ms 900000 --report <file>`，覆盖全部 seed 文档、operator 文件保护、Supervisor/bwrap/Pi 与本地 mock provider。旧 `--suite target` 的 `docker run --entrypoint node` 只是调试 harness，不是入口证据。Windows 本机未执行 Linux/Docker/namespace/24h；YAML、脚本语法或 skip 不能当作目标通过。

## 插件与供应链

`pi-continuity@0.3.1` 与 `pi-better-web-search@0.1.7` 构建时用 `pi install npm:...@版本` 安装，Pi 资源发现实际加载，并与 `package-lock.json` 核验。安装强制 `npm_config_ignore_scripts=true`，依赖用 `npm ci --ignore-scripts`；lifecycle 不执行，版本锁不关闭。

插件在 Worker 内运行任意代码，拥有 Worker 的 OS 权限。固定版本、预检、3 轮健康与 LKG 只降低故障风险，不证明代码安全。operator config 每次启动按 state 基线校验，Agent 改写即拒绝重启。

## 托管 Markdown 的实际范围

只有 `/data/markdowns/` 下直接 `*.md` 受 broker 管理：名称/层级/链接校验、单文件 1000 词、总数 20（含 Memory/index）、Memory 限 500 词。Worker 对这些路径只读；write/edit 走 broker，bash/扩展写入被只读绑定阻止。

该限制不覆盖整个磁盘。Worker 可在 workspace、`/data/plugins`、`/data/tools`、`/data/workflows` 创建不受管的 `*.md`；不能修改受保护命名空间。无磁盘白名单或 watcher，不能宣称任何位置都无法创建 Markdown。状态目录对 Agent 不可写且无别名；绕过依赖 canonical path、`nlink=1`、独立 uid 与 hardlink 保护。

## 网络、凭据与日志

容器默认桥接网络、无端口映射，控制 socket 只在状态卷。Worker 出站网络不受限；`web_search` 需真实凭证，用环境变量或只读 secret 提供，绝不写入镜像、示例、Markdown 或普通日志。`.env`/`secrets` 不入构建上下文；日志轮转只限容量，不保证第三方插件不打印敏感信息。

IPC 用一次性 token、launchId/generation/session 认证并拒绝第二 peer；token 不经 argv/env/日志/文件，但仍在 Worker 内存，不能防同进程恶意 JS。健康/reload 只信任已认证的当前 Worker；3 轮健康是进程内自证，不能证明抗已攻陷 Worker。预检也不隔离恶意宿主内核或已控制 Supervisor。

人工提示词由用户提供并只读挂载；缺失、空、符号链接、硬链接或非普通文件均失败关闭，不生成默认提示词或人格。健康检查读取实际状态与进程存活，显式睡眠视为健康。结论仅覆盖本机已执行测试；Linux Docker、namespace、seccomp/AppArmor 与 24h 仍未验证。
