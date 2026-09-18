# CCApproval — Claude Code 自动审批守卫

受 Reddit 帖子启发：烦透了给 Claude Code 的每个操作点"批准"，但又不敢给它无限制权限。

CCApproval 是一个本地守护程序，挂在 Claude Code 的 **PreToolUse 钩子**上：

- ✅ **绝大多数操作**（读文件、跑脚本、链式命令、写代码…）→ **立即自动放行，零打扰**
- ✅ **危险操作**（删文件、`git push`、发布包…）→ **同样自动放行**，仅记录审计日志
- ⛔ **灾难操作**（`rm -rf /`、删系统目录、`mkfs`…）→ 瞬时拒绝（不涉及人工）

> **本项目不做人工授权。** Claude Code 自己就有授权弹窗，没必要再实现一遍。
> 策略引擎判不了的操作，直接把控制权交回 Claude Code —— 由它的原生弹窗处理。
> 这里只负责**自动放行 / 自动拒绝**，外加一份可回看的日志。

## 决策流程

```
Claude Code 工具调用
        │
   PreToolUse hook ──► 策略引擎（本地规则，无网络、无等待）
        │
        ├─ allow ──────────────────► 立即放行        日志: auto-approved
        ├─ deny  ──────────────────► 立即拒绝        日志: policy-denied
        └─ ask
             ├─ 内置危险模式 + dangerousDefault=allow ► 自动放行
             └─ 其余 ──────────────► 交回 Claude Code  日志: escalated
                                        （由它的原生弹窗处理）

每次调用追加一行到 ~/.ccapproval/history.jsonl
```

## 覆盖范围

`install.js` 注册两条 hook：

| 事件 | 覆盖的工具 | 说明 |
|---|---|---|
| `PreToolUse` | `Bash` `PowerShell` `Read` `Glob` `Grep` `Write` `Edit` `NotebookEdit` `WebFetch` `Agent` `ExitPlanMode` `mcp__Claude_Browser__.*` | 走策略引擎判定 |
| `PermissionRequest` | `ExitPlanMode` | 计划审批走的是这个事件而不是 PreToolUse，所以必须单独注册一条 |

`Bash` 和 `PowerShell` 共用同一套命令规则，判定完全一致。

`Read` / `Glob` / `Grep` 也在覆盖范围内——**读取工作目录之外的文件**（就是"Path is outside allowed working directories"那个弹窗）实测能被 hook 放行掉，不再弹窗。

浏览器预览类的 MCP 工具（起服务、截图、点击…）会一起纳入。**其余 MCP 服务器故意没有覆盖**——会话管理那类工具里有 `delete_session`、`archive_session` 这种破坏性操作，保持原生弹窗更稳妥。想让它们也自动放行，把 `install.js` 里的 `mcp__Claude_Browser__.*` 改成 `mcp__.*` 重新注册即可。

> 注册分两层：`node install.js` 写项目级 `./.claude/settings.json`，`node install.js --global` 写 `~/.claude/settings.json`。**没有项目级注册的目录会用全局那份**，所以改了 matcher 记得两边都跑一次，否则别的项目还在用旧配置。

### hook 拦不住的

以下几类是 Claude Code 应用层的"永远询问"动作，**任何 hook、任何权限模式都压不掉**，只能手动点：

- 启动 dev server —— 就是 `launch.json` 里配置的那个"允许启动 xxx？"。实测：hook **能看到并且已经放行**这个调用（日志里是 `mcp__Claude_Browser__preview_start → allow`），但应用层这个弹窗不认 hook 的决定，照样会弹。真要绕开它，就别用 `launch.json`，直接用命令起（`npm run launch` 走的是 Bash，hook 能接管）
- 写入 `.claude/settings.json` —— Claude Code 不允许 agent 静默改写自己的权限配置。实测：hook 已经放行该命令（日志里是 `Bash → allow`），弹窗照样出现，而且全局开着 `bypassPermissions` 也照样弹。**这道门拦不住是应该的**：如果 hook 能自动批准改写权限配置，被约束的一方就能自己解除约束了。所以 `node install.js` 重新注册时总会弹一次，属正常
- 归档 / 删除会话
- `AskUserQuestion` 这类必须交互的工具
- 命中 managed deny 列表的操作（hook 只能收紧权限，不能放宽）

## 快速开始

### 🖱️ 一键启动（Windows）

双击 **`CCApproval.vbs`** —— 静默无窗口，自动装依赖、后台拉起日志面板、并在浏览器打开。
（想看日志输出就双击 `start.bat`；停止用 `stop.bat`。）

### ⌨️ 命令行

```bash
npm run launch      # 一键：装依赖检查 + 后台启动 + 打开日志面板（幂等）
npm run stop        # 停止后台服务
```

首次使用还需注册 hook（一次即可）：

```bash
node install.js             # 注册到 ./.claude/settings.json；--global 对所有项目生效
```

注册后在 Claude Code 里执行 `rm somefile`，它会被自动放行，并在日志面板里留下一条 `auto-approved` 记录。

> 日志面板是**可选的**：hook 完全独立运行，不依赖服务在线。不启动面板一样正常审批。

## 配置 `config.json`

| 字段 | 说明 | 默认 |
|---|---|---|
| `port` | 日志面板端口 | `4317` |
| `host` | 日志面板绑定地址 | `127.0.0.1` |
| `unmatchedDefault` | 没有任何规则命中时：`allow`（全自动）/ `ask`（交回 Claude Code） | `allow` |
| `dangerousDefault` | 命中**内置**危险模式时：`allow`（全自动）/ `ask`（交回 Claude Code） | `allow` |
| `historyLimit` | 面板显示多少条记录（文件里仍保留最近 5000 行，只是不再全显示） | `10` |
| `rules.deny / ask / allow` | 自定义规则（见下） | 见 `src/policy.js` |

> 配置文件有两层：项目根 `config.json` 和 `~/.ccapproval/config.json`，后者覆盖前者。
> 面板访问密钥首次运行自动生成到 `~/.ccapproval/secret`，链接里带它即可访问。

`ask` 的两层含义要分清：

- **你自己写在 `rules.ask` 里的规则**一定会交回 Claude Code，不受 `dangerousDefault` 影响 —— 显式配置优先于默认开关
- **内置危险模式**是否交回，由 `dangerousDefault` 决定。默认 `allow` 表示"危险操作也自动放行"，也就是原帖要的零打扰效果

### 规则写法

```json
{ "tool": "Bash",            // 工具名正则
  "command": "\\brm\\b",     // Bash 命令正则（三选一或多选，全满足才命中）
  "path": "\\.env$",         // 文件路径正则（Write/Edit）
  "pattern": "...",          // 整个 tool_input JSON 的兜底正则
  "reason": "为什么要拦" }
```

判定顺序：**deny → ask → allow → 默认值**。你自己写的规则排在内置规则前面。

> 内置 deny 规则只在**命令位置**匹配——命令开头，或 `;` `&&` `|` `(` `then` `do` 之后。所以提交信息、`echo`、文档里只是**引用**一条危险命令时不会被硬拒（deny 是无条件拒绝，误报没法补救）。ask / allow 规则仍然扫描整串。

内置 ask（危险，默认自动放行）：文件删除、`git push/reset --hard`、包发布、`kubectl/terraform` 变更、`curl|bash`、关机等。
内置 deny（灾难，永远拒绝）：`rm -rf /`、删 Windows 系统目录、`mkfs` 等。

## 日志面板

```bash
npm run launch      # 或 node src/server.js
```

打开 `http://127.0.0.1:4317/?t=<secret>`，是一张**只读**表格，没有批准/拒绝按钮：

| 时间 | 工具 | 结果 | 原因 | 操作内容 |
|---|---|---|---|---|
| 09-18 10:33:15 | Bash | 自动放行 | 无规则匹配 | `npm test` |
| 09-18 10:34:02 | Bash | 已逃逸 | 危险操作自动放行: file deletion | `rm -rf build` |

三种结果：

- **自动放行** —— 策略引擎放行，或危险操作被 `dangerousDefault` 自动放行
- **策略拒绝** —— 命中 deny 规则
- **已逃逸** —— 策略没判，交回 Claude Code 原生弹窗处理；这一列就是看"哪些操作没被自动覆盖"

新记录会通过 SSE 实时推到页面，不用手动刷新。悬停"操作内容"可看完整 tool_input。

## 卸载

```bash
node install.js --uninstall        # 移除 hook（--global 对应全局）
```

## 一键启动相关文件

| 文件 | 作用 |
|---|---|
| `CCApproval.vbs` | 双击静默启动（无黑窗），推荐日常使用 |
| `start.bat` | 带控制台输出的启动（首跑自动 `npm install`） |
| `stop.bat` / `npm run stop` | 停止后台服务（按 PID 文件精确结束，含兜底扫描） |
| `scripts/launch.js` | 幂等启动器：已在运行则直接打开面板 |
| `scripts/stop.js` | 停止逻辑 |

服务在后台运行，PID 记录于 `~/.ccapproval/server.pid`，日志在 `~/.ccapproval/server.out.log`。

## 测试

```bash
npm test    # 策略引擎 27 例 + 端到端（自动放行 / 交回 Claude Code / 策略拒绝 / 计划自动通过 / 坏 payload 拒绝放行）
```

## 文件结构

```
src/hook.js       钩子入口（PreToolUse 判定每次工具调用 + PermissionRequest 自动通过计划，纯本地）
src/policy.js     规则引擎（内置安全/危险模式）
src/store.js      审计日志（history.jsonl，追加写）
src/server.js     只读日志面板（不参与任何决策）
src/dashboard.js  面板页面渲染
src/config.js     配置加载（项目级 + 用户级 + 环境变量）
install.js        注册/卸载 Claude Code hook
```
