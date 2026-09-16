# CCApproval — Claude Code 远程审批守卫

受 Reddit 帖子启发：烦透了给 Claude Code 的每个操作点"批准"，但又不敢给它无限制权限。

CCApproval 是一个本地守护程序，挂在 Claude Code 的 **PreToolUse 钩子**上：

- ✅ **绝大多数操作**（读文件、跑脚本、链式命令、写代码…）→ **立即自动放行，零打扰**
- ✅ **危险操作**（删文件、`git push`、发布包…）→ **同样自动放行**，仅记录审计日志
- ⛔ **灾难操作**（`rm -rf /`、删系统目录、`mkfs`…）→ 瞬时拒绝（不涉及人工）

> 本项目是**纯自动审批器**：默认没有任何人工环节。两档开关都在 `config.json`：
> - `"remoteAction": "allow"`（默认）— 危险操作自动放行；改为 `"remote"` 恢复「危险操作需远程人工批准」（邮件/飞书/面板）
> - `"unmatchedDefault": "allow"`（默认）— 未知操作自动放行；改为 `"remote"` 则未知操作都需人工审

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

### 🖱️ 一键启动（Windows）

双击 **`CCApproval.vbs`** —— 静默无窗口，自动装依赖、后台拉起服务器、并在浏览器打开审批面板。
（想看日志输出就双击 `start.bat`；停止用 `stop.bat`。）

### ⌨️ 命令行

```bash
npm run launch      # 一键：装依赖检查 + 后台启动 + 打开面板（幂等，重复执行无副作用）
npm run stop        # 停止后台服务器
```

首次使用还需注册 hook（一次即可）：

```bash
node install.js             # 注册到 ./.claude/settings.json；--global 对所有项目生效
```

邮件通知（可选）：编辑 `config.json` 填入 SMTP 授权码（首次 launch 会自动从示例生成该文件）。

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

判定顺序：**deny → remote → allow → 默认 allow（全自动）**。用户规则优先于内置规则。

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

## 一键启动相关文件

| 文件 | 作用 |
|---|---|
| `CCApproval.vbs` | 双击静默启动（无黑窗），推荐日常使用 |
| `start.bat` | 带控制台输出的启动（首跑自动 `npm install`） |
| `stop.bat` / `npm run stop` | 停止后台服务器（按 PID 文件精确结束，含兜底扫描） |
| `scripts/launch.js` | 幂等启动器：已在运行则直接打开面板 |
| `scripts/stop.js` | 停止逻辑 |

服务器在后台运行，PID 记录于 `~/.ccapproval/server.pid`，日志在 `~/.ccapproval/server.out.log`。

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
