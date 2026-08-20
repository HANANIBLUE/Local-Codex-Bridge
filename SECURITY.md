# 安全策略

Local Codex Bridge 能够把 MCP 请求转交给本机 Codex。安全问题可能影响本机文件、命令、线程历史、审批请求或敏感运行环境，因此请谨慎处理漏洞细节。

## 支持范围

安全修复以最新公开版本和当前 `main` 分支为主。较旧版本可能需要先升级才能获得修复。

## 私密报告漏洞

如果仓库已启用 GitHub Private Vulnerability Reporting，请在仓库的 **Security** 页面选择 **Report a vulnerability**。不要在公开 Issue 中发布以下内容：

- API key、Tunnel profile、凭据、日志或 checkpoint
- 可直接复现的破坏性 payload
- 未公开的本机路径、线程内容或用户数据
- 绕过 sandbox、approval policy、pending request scope 或敏感信息清理的完整细节

如果私密报告入口尚未启用，请创建一个不含敏感细节的公开 Issue，请维护者提供私密联系方式。

报告中可以安全包含：受影响版本、操作系统、影响摘要、最小化且已清理的复现条件，以及建议的缓解方式。

## 不属于安全边界的行为

Bridge 不会创建新的操作系统沙箱。Codex 的文件、命令、网络和进程能力由实际 Codex 配置、每回合 sandbox 与 approval policy 决定。已明确授权的高权限配置本身不构成 Bridge 漏洞，但配置与公开 schema 或声明边界不一致可能构成安全问题。
