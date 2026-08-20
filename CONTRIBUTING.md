# 贡献指南

感谢你改进 Local Codex Bridge。请让变更保持小而清楚，并继续维护 Bridge 作为薄控制层的既有边界。

## 开发环境

- Windows 或 macOS
- Node.js 24 或更高版本
- 仅在真实 smoke 测试时需要可用的官方 Codex 可执行文件

安装依赖并运行确定性检查：

```text
npm ci
npm run typecheck
npm test
```

`npm test` 会在 Windows 运行 Tray 测试，在其他平台明确跳过该平台专用部分。可以在 Windows 使用 `npm run test:tray` 单独验证 Tray。

## 提交变更

- 不要提交 API key、Tunnel ID、Tunnel profile、健康地址、本机绝对路径、PID、日志或 checkpoint。
- 不要提交 `node_modules/`、`dist/`、`.env*` 或 `windows/local-settings.json`。
- 新增平台支持时，请同时更新路径校验、checkpoint 默认目录、测试、CI、README 和更新日志。
- 不要通过削弱 schema、权限边界或测试来让变更通过。
- `npm run smoke:live` 会调用真实 Codex 并留下持久线程；只有在明确接受副作用时才运行。

## Pull Request 检查表

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 通过
- [ ] `git diff --check` 通过
- [ ] 没有凭据或维护者机器配置
- [ ] 用户可见变化已写入 README 和 CHANGELOG
- [ ] 版本字段在 package metadata、Bridge client info、MCP server info 和测试中保持一致

## 项目身份

本项目是非官方社区项目，与 OpenAI 不存在隶属、授权或背书关系。贡献内容须符合仓库的 MIT License，并保留上游版权与许可证声明。
