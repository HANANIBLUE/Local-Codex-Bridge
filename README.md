# Local Codex Bridge

*A thin MCP control bridge from ChatGPT to native Codex sessions.*

Local Codex Bridge 是一个面向 Windows 和 macOS 的轻量 MCP stdio 桥接器：它让 ChatGPT（或其他 MCP 客户端）能够调用本机原生 Codex 会话，同时把真正的线程、回合、历史记录和执行能力继续交给官方 Codex app-server 管理。

它解决的是一个很具体的问题：ChatGPT 适合对话、拆解目标和持续监督，Codex 则能在本机工作区里使用真实的文件、命令和开发工具。Bridge 在两者之间提供 7 个边界清楚的控制工具，不再额外发明一套任务系统。

## 当前公开版本

**V2.2.0** · [查看更新日志](CHANGELOG.md)

本版本在保持 7 个 MCP 工具和既有监督边界不变的前提下，新增 macOS 主机原生路径、checkpoint 默认目录、跨平台 smoke prompt 和测试入口支持。核心 Bridge 现声明支持 Windows 与 macOS；可选 Tray 仍仅支持 Windows。

> [!IMPORTANT]
> 这是非官方社区项目，与 OpenAI 不存在隶属、授权或背书关系。ChatGPT、Codex 和 OpenAI 是其各自权利人的产品或标识。

## 它是怎样工作的

真实的数据链路是：

```text
ChatGPT / 其他 MCP 客户端
        │
        │ MCP JSON-RPC（stdio；远程场景可由 Secure MCP Tunnel 接入）
        ▼
Local Codex Bridge
        │
        │ Codex app-server JSONL（stdio）
        ▼
官方 Codex：codex app-server --listen stdio://
        │
        └── 本机原生线程、回合、历史记录与执行权限
```

换句话说，Local Codex Bridge 是提供给 ChatGPT 的 MCP Server；Codex app-server 是 Bridge 在内部驱动原生 Codex 的官方协议进程。它们不是同一个接口，也不是两套并行的任务系统。

当工具首次需要原生 Codex 时，Bridge 会懒启动一个官方 app-server 子进程。Bridge 自己不创建 job ID、不维护队列、不保存第二份对话历史，也不会自动重试或自动重启意外退出的 app-server。

## 7 个 MCP 工具

| 工具 | 用途 | 重要边界 |
| --- | --- | --- |
| `codex_threads` | 列出、搜索或读取原生 Codex 持久线程 | `cwd` 和搜索词只是筛选条件，不是权限边界；不会重建已经丢失的 Bridge 实时事件 |
| `codex_turn` | 新建或恢复线程，并启动一个回合 | 新线程必须提供主机原生绝对路径；返回“已接受”不等于任务完成 |
| `codex_observe` | 读取有界的实时事件、待处理请求、终态和游标 | `wait_ms` 最长 10 秒，只做一次事件驱动等待；安静不代表卡死 |
| `codex_steer` | 向同一个活动回合追加纠正或新意图 | 必须匹配准确的 `thread_id` 和 `expected_turn_id`；不会新建回合 |
| `codex_respond` | 回答真实的审批、用户输入、权限或 elicitation 请求 | 必须使用原始 request ID 及准确的线程、方法和回合范围；不能虚构请求 |
| `codex_interrupt` | 中断准确的活动线程与回合 | 只发送原生 `turn/interrupt`；不会停止或重启 Bridge / app-server |
| `codex_checkpoint` | 为长任务保存可选、精简且有界的监督锚点 | 不是转录、日志、任务 ID 或 Codex 历史；原始目标、约束和验收条件初始化后不可变 |

所有工具都公开对象输入 schema，以及 MCP 的只读、破坏性、幂等和 open-world 提示。完整字段和限制以 [`src/tools.ts`](src/tools.ts) 为准。

## 快速开始

### 环境要求

- Windows 或 macOS
- Node.js 24 或更高版本
- 官方 Codex 可执行文件：可以直接通过 `codex` 命令找到，也可以用 `CODEX_EXE` 指定

本项目不捆绑、也不依赖 `@openai/codex` npm 包。

### 安装、构建与测试

```text
git clone <repository-url>
cd Local-Codex-Bridge
npm ci
npm run typecheck
npm run build
npm test
```

将 `<repository-url>` 替换为当前 GitHub 仓库的 clone URL。

构建后可在终端直接启动：

```text
# Windows PowerShell
$env:CODEX_EXE = 'C:\path\to\codex.exe'

# macOS shell
export CODEX_EXE='/absolute/path/to/codex'

npm start
```

`codex` 已在 `PATH` 时可以省略 `CODEX_EXE`。

接入 MCP 客户端时，请把 stdio 命令直接配置为：

```text
command: node
args:    <absolute repository path>/dist/src/index.js
env:     CODEX_EXE=<absolute Codex executable path>   # 可选
```

不同客户端的配置文件格式并不相同，但最终应直接运行 `node dist/src/index.js`。不要在 Secure MCP Tunnel 或其他严格的 JSON-RPC stdio 客户端后面使用 `npm start`，因为 npm 生命周期输出可能污染 stdout 协议流。

## 如何监督一个回合

`codex_turn` 只确认 `turn/start` 已被接受。需要持续监督时，应使用有界的 `codex_observe` 等到终态，并在每次返回后检查新事件、待处理请求和当前状态，再决定是否继续观察、`codex_steer`、`codex_respond` 或 `codex_interrupt`。

- 长时间没有新命令或输出，不足以证明 Codex 卡住了。
- 只有新证据或用户意图发生变化时才应 steer。
- 只有确实存在的 pending request 才能 respond。
- 只有明确需要停止当前回合时才应 interrupt。
- 是否复用线程取决于任务连续性和上下文价值；`thread_id` 不是永久任务编号。

## 可选：Secure MCP Tunnel

远程 MCP 连接可以在 Bridge 前面放置 Secure MCP Tunnel。先完成构建，再把 Tunnel 的 MCP command 指向：

```text
node <absolute repository path>/dist/src/index.js
```

Tunnel 的安装、认证、profile、端口、ready endpoint 和进程生命周期都属于外部配置。本仓库不会创建或修改 Tunnel profile，也没有内置生产端口或凭据。

## 可选：Windows Tray

`windows/` 中的 Tray 是单独安装的 Tunnel client 的轻量启动与状态层，不是 Bridge 的必要组成部分。规范入口是 `LocalCodexBridgeTray.*`。它读取命令行参数、generic 环境变量，或本机 ignored 文件 `windows/local-settings.json`：

```powershell
.\windows\LocalCodexBridgeTray.Debug.cmd `
  -ReadyUrl 'http://127.0.0.1:<port>/readyz' `
  -ProfileName 'your-profile' `
  -TunnelExecutable 'C:\path\to\tunnel-client.exe'
```

本机 settings 文件的模板是 [`windows/local-settings.example.json`](windows/local-settings.example.json)，实际的 `windows/local-settings.json` 不进入 Git。解析优先级为：显式命令行参数、`LOCAL_CODEX_BRIDGE_*` 环境变量、旧的 `LUMEN_CODEX_V2_*` 环境变量、ignored local settings。新安装没有 local settings 时，Tray 会要求显式提供必要配置；不会把维护者机器的 profile、端口或可执行文件写入 tracked tree。

旧的 `LumenCodexControlV2Tray.*` launcher 文件名和旧环境变量仍作为兼容入口保留；它们只转发到同一份 canonical implementation，不代表第二套产品或第二套配置。现有旧 checkpoint/UX 路径也不会被迁移或删除。

Tray 不会自动重启 Tunnel。它只检查配置的 readiness URL；停止时，也只会在可执行路径、命令行、profile、启动时间、PID 和 PID 文件重新核验一致后，停止由当前 Tray 实例启动的那个 Tunnel 进程。

## 安全与信任边界

Local Codex Bridge 不会创建新的操作系统沙箱。真正的文件、命令、网络和进程权限，来自官方 Codex 的配置，以及每个回合请求的 `sandbox` 与 `approval_policy`。`danger-full-access` 会放宽沙箱对文件、命令和进程访问的限制；`approval_policy=never` 不会扩大操作系统沙箱，但会取消交互式审批这道确认环节。两者的风险来源不同，都应只在已经理解并接受相应边界时使用。

还需要明确以下边界：

- `codex_turn` / `codex_steer` 传入的文本可能促使 Codex 使用其已配置的命令和文件能力；“没有直接暴露 shell 工具”不等于“不会执行本机操作”。
- `codex_threads` 能看到同一操作系统用户和同一 Codex app-server 可见的持久线程；`cwd` 与搜索条件不能隔离访问。
- Bridge 会把自身进程环境继承给 app-server 子进程。启动环境应被视为可信边界，不要放入无关且不必要的秘密。
- 实时事件和 pending request 会被限量，并对明显的敏感内容做清理；这只能减少意外暴露，不能把 Bridge 变成敌对多租户网关或跨用户隔离层。
- 远程使用时，应由经过认证、配置正确的 Tunnel 提供连接边界；不要把本地 stdio 控制面直接暴露给不可信来源。
- checkpoint 应保持简短且不含敏感信息；不要保存 prompt、逐字记录、原始事件、命令输出或最终回答。

## 持久化与当前限制

- 原生线程、回合、历史和最终输出由官方 Codex 持久化。
- Bridge 的事件 ring、活动回合状态和 pending request 只在内存中存在。Bridge 重启后，`codex_observe` 可以回退读取持久历史，但会明确标记实时状态无法重建。
- Windows 新安装的 checkpoint 默认位于 `%LOCALAPPDATA%\LocalCodexBridge\checkpoints\<sha256(thread_id)>.json`；macOS 默认位于 `~/Library/Application Support/LocalCodexBridge/checkpoints/<sha256(thread_id)>.json`。可用 `LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR` 指定其他绝对目录。Windows 若检测到既有旧默认目录，Bridge 会继续使用它；也可用旧的 `LUMEN_CODEX_V2_CHECKPOINT_DIR` 显式指定，不会自动迁移数据。
- app-server 意外退出后会被锁定为失败状态，不会在同一个 Bridge 进程中自动重启。
- `cwd` 使用 Bridge 主机的原生绝对路径：Windows 接受盘符路径并拒绝 UNC 或 Windows device path；macOS 接受 POSIX 绝对路径。
- Windows Tray 仍只支持 Windows，并依赖 Windows PowerShell、Windows Forms 和 WMI/CIM；本项目尚未声明或验证 Linux 支持。
- Bridge 不是任务队列、后台监控器、HTTP MCP Server、通用 shell endpoint、Codex 运行时安装器或 Tunnel profile 管理器。

## 开发与测试

常用检查：

```text
npm run typecheck
npm run build
npm test
```

`npm test` 会构建项目，并运行 runtime、app-server、MCP、checkpoint 和 UX projection 测试；Windows Tray 测试仅在 Windows 上运行。

`npm run smoke:live` 与单元测试刻意分开：它会调用真实 Codex、启动只读 smoke 任务，并留下持久测试线程。只有在明确接受这些副作用时才运行。

主要实现位置：

- `src/mcp.ts`：MCP stdio / JSON-RPC 边界
- `src/app-server.ts`：官方 Codex app-server 子进程与协议适配
- `src/tools.ts`：7 个工具的 schema、校验和语义
- `src/runtime.ts`：有界实时状态、事件与 pending request
- `src/checkpoint.ts`：可选监督 checkpoint 与旧目录兼容
- `src/ux-projection.ts`：可选 UX 投影与旧环境变量兼容
- `windows/`：可选 Tray、local settings 与 legacy launchers

## 许可证

本项目采用 MIT License，详见 [`LICENSE`](LICENSE)。

本版本基于 [zoeynine/Local-Codex-Bridge](https://github.com/zoeynine/Local-Codex-Bridge) 的公开代码与历史继续开发；重新分发时请保留原始 MIT License 和版权声明。

欢迎提交改进；开始前请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md) 和 [`SECURITY.md`](SECURITY.md)。

## 协作贡献者与致谢

协作贡献者：**小年（ChatGPT）**、**Codex**。谢谢两位一起把想法、边界和实现认真地走到了可以公开分享的版本，也谢谢这段彼此配合、反复打磨的过程。`(*╹▽╹*)`
