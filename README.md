# CCApproval — Claude Code 远程审批守卫

受 Reddit 帖子启发：烦透了给 Claude Code 的每个操作点"批准"，但又不敢给它无限制权限。

CCApproval 是一个本地守护程序，挂在 Claude Code 的 **PreToolUse 钩子**上：

- ✅ **安全操作**（读文件、`git status`、`npm test`…）→ 立即自动放行，不打扰你
- ⛔ **红线操作**（`rm -rf /`、删系统目录…）→ 直接拒绝
- 📧 **危险操作**（删文件、`git push`、发布包、改 `.env`…）→ 发邮件/Webhook 通知你，**在手机上点一下批准/拒绝，还能修改命令后再放行**

```
Claude Code 工具调用
        │
   PreToolUse hook ──► 策略引擎（本地规则）
        │
   ┌────┴─────────────┐
  allow/deny        remote（危险）
   立即返回           │
                     ▼
              本地审批服务器 :4317
                │           │
            邮件按钮链接   Web 审批面板
                │           │
              你在远程批准/拒绝/改命令
                     │
              hook 轮询到决定 → 返回给 Claude Code
              （超时则回退到普通提示，永不卡死）
```

## 快速开始

```bash
npm install
cp config.example.json config.json   # 填入你的 SMTP 配置（可选）
node install.js                       # 注册 hook 到 ./.claude/settings.json（--global 全局）
npm start                             # 启动审批服务器（hook 也会自动拉起它）
```

然后在 Claude Code 里执行 `rm somefile`，你会收到一封带 **✅批准 / ❌拒绝** 按钮的邮件。

## 配置 `config.json`

| 字段 | 说明 | 默认 |
|---|---|---|
| `port` | 审批服务器端口 | `4317` |
| `publicUrl` | 邮件里链接用的地址（手机要点得通，填局域网 IP 或内网穿透域名） | 自动探测 |
| `timeoutMs` | hook 等待远程决定的最长时间 | `180000` |
| `fallback` | 超时/服务器不可用时：`ask`（弹原生提示）/ `deny` / `allow` | `ask` |
| `notify.email` | nodemailer SMTP 配置（QQ/163/Gmail 授权码均可） | 无 |
| `notify.webhook` | 飞书/钉钉自定义机器人 Webhook URL | 无 |
| `rules.deny / remote / allow` | 自定义规则（见下） | 见 `src/policy.js` |

> 配置文件有两层：项目根 `config.json` 和 `~/.ccapproval/config.json`，后者覆盖前者。
> 审批密钥在首次运行时自动生成到 `~/.ccapproval/secret`， dashboard 链接里带它即可访问。

### 规则写法

```json
{ "tool": "Bash",            // 工具名正则
  "command": "\\brm\\b",     // Bash 命令正则（三选一或多选，全满足才命中）
  "path": "\\.env$",         // 文件路径正则（Write/Edit）
  "pattern": "...",          // 整个 tool_input JSON 的兜底正则
  "reason": "为什么要审批" }
```

判定顺序：**deny → remote → allow → 默认 remote（人工审核）**。用户规则优先于内置规则。

内置 remote（需远程审批）：文件删除、`git push/reset --hard`、包发布、`kubectl/terraform` 变更、`curl|bash`、关机等。
内置 deny：`rm -rf /`、删 Windows 系统目录、`mkfs` 等。

## 远程审批的三种方式

1. **邮件按钮**：一键 allow/deny（GET 链接，带密钥签名）
2. **Web 面板**：`http://<你的IP>:4317/?t=<secret>` —— 待审批列表、历史记录，支持**粘贴修改后的 JSON input 再批准**（对应帖子里的 "change the command"）
3. **API**：`POST /api/decide { id, action, updatedInput? }` —— 方便接入 n8n 等工作流（帖子里用的 N8N + MCP 方案可直接对接这个 API）

## 手机外网访问

`publicUrl` 默认是局域网 IP。外出时可用内网穿透：

```bash
cloudflared tunnel --url http://localhost:4317
# 把生成的 https://xxx.trycloudflare.com 填进 config.json 的 publicUrl
```

所有决策链接都带 secret，泄露风险可控；生产使用建议把 `host` 改回 `127.0.0.1` 只走隧道。

## 卸载

```bash
node install.js --uninstall        # 移除 hook（--global 对应全局）
```

## 测试

```bash
npm test    # 策略引擎 14 例 + 端到端（自动放行 / 远程批准 / 策略拒绝）
```

## 文件结构

```
src/hook.js       PreToolUse 钩子（Claude Code 每次工具调用时拉起）
src/server.js     审批服务器 + REST API
src/dashboard.js  手机友好的审批面板
src/policy.js     规则引擎（内置安全/危险模式）
src/store.js      文件队列（hook 与 server 解耦）
src/notify.js     邮件 + Webhook 通知
src/config.js     配置加载（项目级 + 用户级 + 环境变量）
install.js        注册/卸载 Claude Code hook
```
