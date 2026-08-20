# 更新日志

本文件只记录当前公共仓库 Git 历史中可以核验的事实。当前公开版本为 **V2.2.0**；公共历史中没有单独的 V2.1.0 发布记录。

## V2.2.0（2026-08-21）

- 核心 Bridge 新增 macOS 支持：Windows 继续接受绝对盘符路径并拒绝 UNC / device path，macOS 接受 POSIX 绝对路径。
- checkpoint 默认目录按主机平台选择：Windows 使用 `%LOCALAPPDATA%`，macOS 使用 `~/Library/Application Support/LocalCodexBridge/checkpoints`；既有 Windows 兼容逻辑保持不变。
- live smoke prompt 在 Windows 使用 PowerShell，在 macOS 使用 POSIX 命令；仍只执行明确授权的真实 Codex smoke 测试。
- 完整测试入口在非 Windows 主机跳过 Windows Tray 测试，并保留显式 `npm run test:tray` 命令供 Windows 单独验证。
- GitHub Actions 验证矩阵扩展为 Windows 与 macOS，统一使用 Node.js 24。
- 包版本、Bridge 上游 `clientInfo`、MCP `serverInfo`、测试和公开文档统一为 `2.2.0`。
- 不捆绑 Codex 运行时、Secure MCP Tunnel 客户端、Tunnel profile、凭据或维护者机器路径；Linux 与 macOS Tray 仍不在支持范围内。

## V2.1.2（2026-08-12）

- 对已经发送但确认超时的原生变更请求保留有界的晚到响应上下文；晚到成功或错误会成为已清理、可观察的运行时证据，并以保守规则对账，不自动重试，也不覆盖更新的活动回合或终态。
- 在 app-server 入站边界拒绝重复的未决请求 ID，并以 claim / release / complete 生命周期保护真实 pending request，避免并发响应、身份替换或误清理。
- 当调用者显式请求 sandbox 时，先核验 `thread/start` / `thread/resume` 返回的原生 policy，再把同一 policy 传给 `turn/start`；缺失、类型不符或模式不匹配时在启动回合前失败关闭。
- 将公开工具 schema 中的线程、回合、工作目录、游标和方法字符串上限与既有运行时校验对齐，并把独立 tools 回归测试纳入完整测试套件。
- 将包元数据、Bridge 上游 `clientInfo`、MCP `serverInfo` 与公开文档统一为 `2.1.2`，并补录 V2.1.1 版本化与后续 canonical convergence 提交。
- 保持 7 个工具及既有薄桥边界不变；`codex_observe.wait_ms` 仍默认 `0`、上限 10 秒，仍是一次事件驱动等待，不增加轮询、自动重试、自动重启或进程控制。

## V2.1.1（2026-08-11）

- 完成监督与控制边界加固：会改变原生状态的请求若在发送后等待确认超时，会明确报告结果为 `UNKNOWN`，Bridge 不会自动重试、取消或推断结果。
- 在 MCP 客户端→Bridge 入站边界拒绝仍在处理中的重复活动请求 ID，同时不干扰原请求的取消、清理及后续 ID 复用。
- 收紧 `codex_respond` 的前向兼容边界：只响应具有明确原生契约的已支持方法；未知方法保持已清理、可观察和 pending 状态，并且不发送响应。
- 加强 app-server 与 MCP 回归测试，覆盖变更请求确认超时、原生写入仍 pending、未知请求、已知用户输入响应和 MCP 入站重复活动请求 ID 等边界。
- 将项目包版本、Bridge 上游 `clientInfo`、MCP `serverInfo` 与公开文档统一为 `2.1.1`。

## 可核验的公共历史

- `53e97f6`：将 self-use 与 public 工作树收敛为同一 canonical repository。
- `8991e70`：将 Bridge 收敛到 public-safe canonical tree。
- `53536f2`：回填已接受的 V2.1.1 重复请求加固。
- `9a8b8f3`：归档已接受的 V2.1.1 监督加固状态。
- `0a99f39`：完成 V2.1.1 公共版本化，并由 `v2.1.1` 标记。
- `ccd98f2`：V2.1.1 公共监督边界加固。
- `c28fc37`：中文优先的 README 与 `AGENTS.md` 公共文档完善。
- `8996398`：Local Codex Bridge 初始公共基线。

上述 V2.1.1 发布及早期公共基线提交日期为 2026-08-11；后续加固归档、回填与 canonical convergence 提交日期为 2026-08-12。
