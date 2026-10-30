# RSI-Agent (Recursive Self-Improving Agent)

一个能够从零开始处理未知任务，通过实际执行发现有效方法，再把这些方法沉淀为可复用工具、Markdown 和 Workflow，并持续改进自身任务解决能力的递归式自主 Agent 框架。

基于 Pi SDK (1.4.0) 构建，采用严格的进程外双层沙箱架构（Supervisor + Bubblewrap Worker），实现自主循环、受管记忆沉淀、原子化 Markdown 知识库管理、三轮健康晋升/回滚（LKG）以及有界工具扩展。

---

## 目录

- [核心架构设计](#核心架构设计)
  - [1. 进程外双层边界 (Supervisor & Worker)](#1-进程外双层边界-supervisor--worker)
  - [2. 受管知识与动态记忆系统 (Memory & Markdowns)](#2-受管知识与动态记忆系统-memory--markdowns)
  - [3. 安全热重载与 LKG 回滚机制](#3-安全热重载与-lkg-回滚机制)
  - [4. 有界工具、MCP 与 Skill 管理](#4-有界工具-mcp-与-skill-管理)
  - [5. 受控睡眠与 Watchdog 心跳租约](#5-受控睡眠与-watchdog-心跳租约)
- [文档索引导航](#文档索引导航)
- [目录结构](#目录结构)
- [安装与运行指南](#安装与运行指南)
  - [环境先决条件](#环境先决条件)
  - [Linux Docker 部署](#linux-docker-部署)
  - [Windows Docker Desktop 运行](#windows-docker-desktop-运行)
  - [本地校验与测试](#本地校验与测试)
- [安全边界与 API 密钥规范](#安全边界与-api-密钥规范)

---

## 核心架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                 外层宿主 / 容器 Supervisor (受信)             │
│  - 状态卷 (/state 0700) 与 LKG 候选管理                      │
│  - 统一严格预检 (Unified Runtime Preflight)                  │
│  - 知识 Broker (Memory / Markdown 原子 CAS 更新)             │
│  - Watchdog 进程监控 & 心跳租约检测                          │
│  - 外部睡眠调度器 & 操作员控制接口 (Unix Socket)              │
└──────────────────────────────┬──────────────────────────────┘
                               │ 一次性 Token + 专用 UID/GID
                               ▼ setpriv / bwrap
┌─────────────────────────────────────────────────────────────┐
│             Bubblewrap Worker 沙箱 (uid/gid: 10002)         │
│  - 隔离 Namespace (PID, User, Mount, UTS, IPC)              │
│  - CapEff = 0, no-new-privileges, 遮蔽 /state               │
│  - 只读挂载: RSI/Pi 源码、人工 System Prompt、受管 Markdown   │
│  - Pi SDK 1.4.0 (createAgentSession)                        │
│  - 固定插件: pi-continuity@0.3.1, pi-better-web-search@0.1.7│
│  - 原生发现: 最多 5 个 Skills, 最多 5 个 MCP 服务            │
└─────────────────────────────────────────────────────────────┘
```

### 1. 进程外双层边界 (Supervisor & Worker)

- **Supervisor (外层受信进程)**：运行于容器 root 下，持有系统配置、状态卷 `/state`、候选版本存储和 Watchdog。仅使用 `setpriv --reuid 10002 --regid 10002 --clear-groups` 派生非 root 的 Worker 进程，自身绝不加载不受信扩展。
- **Worker (沙箱执行进程)**：运行于独立的 Bubblewrap 沙箱内，拥有独立的非 root UID/GID (10002)。沙箱丢弃全部 Linux Capabilities（`CapEff=0`），开启 `no-new-privileges`，隔离 PID、User、Mount、UTS 和 IPC namespace。
- **IPC 安全协议**：Supervisor 与 Worker 间通信采用私有 Unix Domain Socket。握手凭据为启动时经继承 `stdin` 传入的 32 字节 CSPRNG 一次性 Token，严格绑定 `launchId`、`generation` 和 `session`，拒绝重放并阻断第二连接抢占。

### 2. 受管知识与动态记忆系统 (Memory & Markdowns)

- **动态记忆 (`Memory.md`)**：
  - 上限严格限制为 **500 词**（使用精确的 Unicode CJK/Latin 独立码点分词算法，汉字单个计词）。
  - 超额写入自动失败关闭，保持旧内容不变。写入成功返回规范元数据：`[System Meta: Current Memory Usage: N / 500 words]`。
  - 每次 LLM Provider 请求前，Worker 通过 IPC 从 Supervisor 获取权威 Memory，动态插入首个 Leading System Message 中，确保多轮工具调用时保持最新记忆。
- **受管知识库 (`/data/markdowns/*.md`)**：
  - 仅直接位于 `/data/markdowns/` 下的扁平 Markdown 受 Broker 管理，总篇数上限 **20 篇**，单篇字数上限 **1,000 词**。
  - 由 `index.md` 建立统一索引（三列结构：`| md名 | description | 链接位置 |`），支持自索引与动态校验。
  - 读取操作（`read(index.md)`）自动在请求时附加 24 小时滚动读取统计与 mtime，且不改变原始文件的磁盘字节与时间戳。更新操作严格经过版本号 CAS 与原子重命名。

### 3. 安全热重载与 LKG 回滚机制

- **禁止不受信代码直载**：Agent 编写的不安全 Pi Extension 绝不会被动态加载；重载仅允许纯数据配置、Skill 声明和 MCP 服务。
- **预检机制**：任何重载必须经过静态语法校验与独立的 3 秒 Mock 子进程探测，发生超时、死循环或错误时自动丢弃。
- **三轮健康晋升 (LKG)**：重载后必须连续经历 3 次正常 `agent_settled`（无未捕获异常、无超时、正常交互）才晋升为外层存储的 **LKG (Last Known Good)** 版本。
- **Watchdog 自动回滚**：Watchdog 依据真实的 Host PID 与心跳租约监测 Worker 状态。若发生异常崩溃或事件循环卡死，自动杀死整个进程树并从 LKG 备份安全恢复。

### 4. 有界工具、MCP 与 Skill 管理

- **数量硬上限**：运行时对外部引入的能力设置严格硬配额，最多加载 **5 个 Skills** 与 **5 个 MCP 服务**，超额注册直接在激活前拒绝。
- **命令垫片 (`pi shim`)**：禁止通过 shell 执行未授权的 Pi 控制命令（如 `/reload`），仅放行官方 MCP 规范调用。
- **工具结果统一装饰**：所有顶级工具输出均自动规范化追加时间戳与系统元数据：`(Current Time: YYYY/MM/DD HH:mm:ss)`，确保跨轮次时序因果一致。

### 5. 受控睡眠与 Watchdog 心跳租约

- **显式睡眠 (`sleep`)**：Agent 暂停自主循环的唯一合法途径是显式调用 `sleep` 工具，支持相对时长（如 `30m`、`2h`）或绝对时区时间（`YYYY/MM/DD HH:mm:ss`）。
- **外部持久化**：睡眠截止时间持久化记录在 Supervisor 状态卷中。睡眠期间保持轻量心跳汇报，Worker 重启后继续等待原始截止时间，到期后触发单次可靠唤醒。

---

## 文档索引导航

受管知识库位于 `markdowns/` 目录，由系统 Broker 统一索引与维护：

| 文档名称 | 核心内容与定位 | 链接 |
| :--- | :--- | :--- |
| **index.md** | 受管 Markdown 目录总索引与请求时元数据规范 | [查看 index.md](markdowns/index.md) |
| **architecture.md** | 进程架构、安全边界、IPC 协议、内存注入与重载生命周期 | [查看 architecture.md](markdowns/architecture.md) |
| **operations.md** | 生产环境与本地部署、预检、健康检查、日志轮转与灾备恢复 | [查看 operations.md](markdowns/operations.md) |
| **security.md** | Bubblewrap 沙箱约束、凭证隔离、插件供应链与防御边界规范 | [查看 security.md](markdowns/security.md) |
| **okx-demo-workflow.md** | OKX 官方 MCP 模拟盘实验流程、已验证行情与受控测试规范 | [查看 okx-demo-workflow.md](markdowns/okx-demo-workflow.md) |
| **Memory.md** | Agent 运行时自主维护的长效动态上下文（初始为空，限额 500 词） | [查看 Memory.md](markdowns/Memory.md) |
| **SETUP.txt** | ClinePass 模型与 OKX 模拟盘配置手册与参数指南 | [查看 SETUP.txt](rsi/SETUP.txt) |

---

## 目录结构

```
RSI-Agent/
├── .github/
│   └── workflows/
│       └── rsi-linux.yml         # Linux+Docker 目标验收与入口测试 CI
├── .dockerignore                 # 容器构建忽略规则 (排除 .env, secrets 等)
├── .gitignore                    # Git 忽略规则 (严格排除 API Key / 凭据)
├── README.md                     # 本说明文档
├── markdowns/                    # 受管知识库种子目录 (只读挂载至沙箱)
│   ├── index.md                  # 受管文档索引
│   ├── architecture.md           # 系统架构设计
│   ├── operations.md             # 部署运维手册
│   ├── security.md               # 安全与沙箱边界
│   ├── okx-demo-workflow.md      # OKX 模拟盘流程与验证记录
│   └── Memory.md                 # 动态记忆上下文 (初始 0 词)
├── pi/                           # Pi Agent & SDK 基础工程包
└── rsi/                          # RSI 核心运行时系统
    ├── Dockerfile                # Debian Trixie + Node 22.19 + bwrap 生产镜像
    ├── compose.yaml              # Docker Compose 生产编排
    ├── compose.windows.yaml      # Windows Docker Desktop 挂载覆盖层
    ├── SETUP.txt                 # ClinePass / OKX 模拟盘接入说明
    ├── system-prompt.txt         # 默认人工只读系统提示词模板
    ├── package.json              # RSI 运行时依赖与检查脚本
    ├── bin/                      # CLI 命令入口 (rsi, pi shim)
    ├── deploy/                   # 预设配置模板 (cline, mcp, seccomp 等)
    ├── reports/                  # 架构设计审计与修复报告
    ├── scripts/                  # 容器启动、预检、健康检查与测试脚本
    ├── src/                      # TypeScript 源码 (control, sandbox, reload, loop 等)
    └── test/                     # 自动化测试套件 (包含 340+ 测试用例)
```

---

## 安装与运行指南

### 环境先决条件

- **操作系统**：Linux（推荐 Debian/Ubuntu，内核支持非特权 user namespaces、`fs.protected_hardlinks=1`、`fs.protected_symlinks=1`）或 Windows WSL2 (Docker Desktop)。
- **容器引擎**：Docker 24+ 与 Docker Compose v2。
- **Node.js**：Node >= 22.19.0。

### Linux Docker 部署

1. **进入运行目录并配置环境变量**：
   ```bash
   cd rsi
   cp deploy/rsi.env.example .env
   ```
2. **编辑 `.env` 文件**：
   - 将 `RSI_SYSTEM_PROMPT_FILE` 设置为宿主机上绝对路径的系统提示词文本（如 `/opt/rsi-operator/system-prompt.txt`）。
   - 设置所选的模型 Provider 凭证（例如 `CLINE_API_KEY`）。
   - **注意：切勿提交 `.env` 文件至任何公开代码库！**
3. **构建并启动容器**：
   ```bash
   docker compose build
   docker compose up -d
   ```
4. **查看状态与日志**：
   ```bash
   docker compose ps
   docker compose logs -f --tail 100 rsi
   ```

### Windows Docker Desktop 运行

在 Windows Docker Desktop (WSL2 后端) 上，使用专属覆盖配置 `compose.windows.yaml`：

```powershell
cd rsi
# 1. 复制并配置 .env
Copy-Item deploy/rsi.env.example .env

# 2. 构建与初始化容器卷
docker compose --project-name rsi-agent -f compose.yaml -f compose.windows.yaml build
docker compose --project-name rsi-agent -f compose.yaml -f compose.windows.yaml create --no-build

# 3. 初始写入只读系统提示词卷
Get-Content -Raw -Encoding UTF8 system-prompt.txt | docker run --rm -i --entrypoint node --mount type=volume,source=rsi-agent_rsi-prompt,target=/target rsi-agent:local -e "process.stdin.pipe(require('fs').createWriteStream('/target/system-prompt.txt'))"

# 4. 启动服务
docker compose --project-name rsi-agent -f compose.yaml -f compose.windows.yaml up -d
docker compose --project-name rsi-agent -f compose.yaml -f compose.windows.yaml ps
```

### 本地校验与测试

在宿主机上快速执行静态检查与轻量回归套件（使用仿真 Provider，无需真实 API Key）：

```bash
cd rsi
# 1. 安装锁定依赖
npm ci --ignore-scripts

# 2. 类型检查与代码校验
npm run check:types
npm run check:plugins

# 3. 执行全面本地测试套件 (包含 320+ 项通过用例)
npm run check
```

---

## 安全边界与 API 密钥规范

1. **API 密钥保护原则**：
   - **绝对禁止**将真实 API Key（如 OpenAI、Anthropic、DeepSeek、ClinePass、OKX 密钥）提交到 Git 仓库或写入 Docker 镜像层。
   - 所有敏感凭据必须严格通过 `.env`（已在 `.gitignore` 中忽略）或宿主机只读挂载文件提供。
   - 日志系统具备敏感值脱敏拦截器（`[REDACTED]`），但仍须避免在 Agent 会话与公开输出中打印敏感文本。
2. **模拟盘交易隔离**：
   - OKX 实验**仅允许使用 OKX 模拟盘专用凭据**（`--demo` 模式，开启只读或模拟交易，**严禁开启提现权限**）。
   - 模型在沙箱内具备受限网络访问，**绝对不得向模型沙箱提供任何实盘交易凭据**。
3. **沙箱边界提示**：
   - Bubblewrap 沙箱有效隔离了宿主机与运行时的关键代码路径（只读绑定、掩蔽 `/state`、禁用能力）。
   - 沙箱不防御模型自主编写的策略逻辑错误或合法的外部出站调用，使用真实模型时应设置合理的配额与人工监督。
