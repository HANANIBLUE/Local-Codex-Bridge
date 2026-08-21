# 安全策略

Local Codex Bridge 能够把 MCP 请求转交给本机 Codex。安全问题可能影响本机文件、命令、线程历史、审批请求或敏感运行环境，因此请谨慎处理漏洞细节。

## 支持范围

安全修复以最新公开版本和当前 `main` 分支为主。较旧版本可能需要先升级才能获得修复。

## 私密报告漏洞

请通过仓库 **Security** 页面中的 **Report a vulnerability** 私密报告安全问题。不要在公开渠道提交以下内容：

- API key、token 或其他 credential
- Tunnel profile
- checkpoint
- 日志中的敏感信息
- 本机私密路径、线程内容或用户数据
- 可直接利用的完整攻击细节

报告中可以安全包含：受影响版本、操作系统、影响摘要、最小化且已清理的复现条件，以及建议的缓解方式。

## 不属于安全边界的行为

Bridge 不会创建新的操作系统沙箱。Codex 的文件、命令、网络和进程能力由实际 Codex 配置、每回合 sandbox 与 approval policy 决定。已明确授权的高权限配置本身不构成 Bridge 漏洞，但配置与公开 schema 或声明边界不一致可能构成安全问题。
