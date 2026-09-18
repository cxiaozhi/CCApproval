# <img src="assets/icon.svg" width="34" align="top" alt=""> CCApproval — Claude Code 自动审批守卫

受 Reddit 帖子启发：烦透了给 Claude Code 的每个操作点"批准"，但又不敢给它无限制权限。

CCApproval 是一个本地守护程序，挂在 Claude Code 的 **PreToolUse 钩子**上。它是一份**白名单**——只有写进名单的操作才会交回 Claude Code 弹窗：

- ✅ **名单之外的一切**（读文件、跑脚本、链式命令、写代码、`rm -rf build`、`git push`、发包…）→ **自动审批，零打扰**
- 🔔 **名单里的操作**（下面那几类别）→ 交回 Claude Code 原生弹窗

> **本项目不做人工授权。** Claude Code 自己就有授权弹窗，没必要再实现一遍。
> 这里只负责**自动审批**；判不了的直接交回 Claude Code —— 由它的原生弹窗处理。
> 外加一份可回看的日志。

结果**只有两种**：自动审批，或交回原生弹窗。没有"硬拒绝"这一档——硬拒一旦误判就没法补救（点不过去），而真正不可挽回的操作 Claude Code 上游本来就不允许自动批准（critical path 上的 `rm`、写 `.claude/**`），把它们交回弹窗，决定权还在你手上。

所以"会不会弹我"这个问题，等价于"它在不在名单里"。加一条规则是唯一的手柄，没有别的开关能改动这件事。

## 决策流程

```
Claude Code 工具调用
        │
   PreToolUse hook ──► 策略引擎（本地规则，无网络、无等待）
        │
        ├─ escalate ──────────────► 交回 Claude Code 日志: escalated
        │                             （由它的原生弹窗处理）
        └─ 其余 ──────────────────► 自动审批        日志: auto-approved

每次调用追加一行到 ~/.ccapproval/history.jsonl
```

## 覆盖范围

`install.js` 注册一条 hook（`PreToolUse`），外加两条 `permissions.allow` 条目——后者为什么是必需品，见下面那节：

| 事件 | matcher | 说明 |
|---|---|---|
| `PreToolUse` | `.*` | 每一次工具调用都进策略引擎 |

> **只在 `PreToolUse` 上注册，这一条是硬性约束，不是风格选择。** 早先的版本在 `PermissionRequest` 上也挂了一份，结果是**每次工具调用都闪一下授权弹窗**：Claude Desktop ≥ 2.x 在这个事件一触发时就先渲染弹窗、再等 hook 回答，所以 hook 答 `allow` 到达时表现为"弹窗刚出现就被撤回"。不答更糟——弹窗会停在那儿。这个事件上没有第三种答法，所以现在**一个字都不答、也不注册**。`src/hook.js` 里 `permission` 那个入口留着当墓碑：万一别的设置文件里还留着旧注册，它也必须什么都不说。

matcher 是 `.*`——**故意不过滤任何东西**。这一点很关键：枚举式的 matcher 注定是不完整的，而**每一个漏写的工具都会静默掉进 Claude Code 原生弹窗**。之前"授权一直在漏"就是这个原因——`Skill`、`WebSearch`、`TodoWrite`、以及除浏览器之外的所有 MCP 服务器都不在枚举里。

改成白名单之后，matcher 没有任何东西需要过滤（该拦谁由名单决定），所以索性全放进来。这也是**为什么白名单比黑名单更省心**：枚举漏了 = 漏授权（静默、危险）；名单漏了 = 少弹一次窗（立刻看得出来）。

> matcher 里只要出现 `^ ( ) $ . *` 这类字符，整串就按**正则**解释（纯名字列表才按精确匹配）。所以写 `.*` 是正则，而写一个光秃秃的 `mcp__server` 会按精确匹配、什么都匹配不到。

### 为什么不在 `PermissionRequest` 上注册

原来在它上面也挂了一份，用来处理计划审批（计划卡走的是那个事件，不是 `PreToolUse`）。现在撤掉了——计划卡已经进了名单，`PreToolUse` 自己就能把它交回弹窗。

**而且那个注册正是"闪"的来源。** 2026-09-18 定位：这个事件不是"每次 shell 调用都触发"，它是**"即将询问用户"的信号**。当时全局开着 `permissions.blockReadsOutsideWorkingDirectories`，而它产生的询问 `bypassPermissions` 也压不住（下一节），于是**几乎每条 Bash 调用都要问一次**；注册在这个事件上的 hook 用约 110 ms 答了一个 `allow`，应用层却已经把弹窗渲染出来了——答一到，窗就被撤回，看起来就是"闪一下自动通过"。会话记录里 08:55:42–08:58:02 那 16 条 `hook_permission_decision`（全是 `allow`、全部指向 Bash 调用）就是这一段：它们既是"确实要弹窗"的证据，也是"闪"的证据。

撤掉注册之后不再闪了，但那些询问**照旧发生**——只是变成停在那里的弹窗。

在这么一个事件上，hook 能给的两种答案都很糟：`allow` = 刚出现的窗被撤回（闪），不答 = 窗停在那儿挡路。没有第三种答法，所以**这个事件不注册、不回答**。名单上的操作照常弹窗，靠的是 `PreToolUse` 返回 `ask`，跟这个事件无关。

### 但普通 shell 命令一开始就不该走到这里

`install.js` 注册时**同时往 `permissions.allow` 写 `Bash` 和 `PowerShell`**。这是照 Claude Code 自己给的解法做的，但它**未必够**——原因见下。

**另一条实测（2026-09-18）**：会话在 `acceptEdits` 下，hook 对一条 `curl` 明确返回了 `allow`，**弹窗照样出现**，同一条命令在日志里留下了两行。Claude Code 在弹窗里直接递上了它自己算好的规则建议：

```json
"permission_suggestions": [{"type":"addRules",
  "rules":[{"toolName":"Bash","ruleContent":"curl -s --max-time 5 http://127.0.0.1:15721/v1/models",
            "behavior":"allow","destination":"localSettings"}]}]
```

这条至今没坐实原因（怀疑是 `defaultMode: auto` 那层分类器），但下面这条**已经坐实**，而且是同一种现场表现。

**根因（2026-09-18 定位，代码级证据）：`permissions.blockReadsOutsideWorkingDirectories: true`。** 这一条在 CLI 里对应一个叫 `outsideReadsBlocked` 的询问原因，而它被登记成 **`bypassImmune`** —— 字面意思：**没有任何权限模式能自动批准它**。证据取自本机 `claude.exe`（2.1.271）内嵌的 JS：

```js
en = { dangerousRemoval:{bypassImmune:true,classifierRouted:true},
       outsideReadsBlocked:{bypassImmune:true,classifierRouted:false},   // ← 就是你开的那条
       denyRulesUnjudged:{bypassImmune:true}, restrictedMode:{bypassImmune:true}, ... }
function $Ne(e){ return co(e).some(n => en[n]?.bypassImmune === true) }
```

生成这条询问的代码就在同一段，共三种触发：

- 「names a path that is computed at run time, which cannot be checked against the read block」—— 脚本里的路径是运行时算出来的，静态看不出来
- 「a command the shell parser cannot analyze asks the person」—— shell 解析不了这条命令
- 「This sed script is not on the allowlist and can read or write any file…」

旁边还有一张解释器表 `T6e`（`python → -c`、`node/bun/tsx → -e --eval -p --print`、`bash/sh/zsh/dash/ksh → -c`、`perl → -e -E`、`ruby → -e`、`php → -r`、`deno → eval` …），说明 CLI 会**把内联脚本里的读操作解出来、逐个对照读封锁**。所以同一形状的 `python -c` 有的弹有的不弹——差别在脚本内容里路径能不能静态确定。实测三例：`for m in ['PIL','numpy','scipy']: __import__(m)`（模块名运行时算）**弹**；`Image.open('boss出现_效果图.png')`（字面量、在工作目录内）不弹；`Image.open(f'_probe/out/layers/{which}.png')`（f-string，运行时算）**弹**。

**于是"hook 的 allow 压不住什么"这个问题有答案了**：压不住的正是被登记为 `bypassImmune` 的原因。`PreToolUse` 的 `allow` 照样执行、日志里那条 `auto-approved` 是真的，但它在权限系统里的位置**早于**这一层询问，两者互不影响——"日志显示自动审批、窗照样弹"就是这么来的，两边都没说谎。

> 要彻底不弹，只有两条路：**关掉这个设置**，或者 `/add-dir` 把要读的目录加进来。注意第二条只治"字面量写在目录外"那一类——**运行时算出来的路径，加多少目录都照样问**。加 `permissions.allow` 规则没用：读封锁的检查排在 allow 规则**之前**。

> **当前选择（2026-09-18）：关掉。** 已从 `~/.claude/settings.json` 的 `permissions` 里摘掉 `blockReadsOutsideWorkingDirectories`（备份 `settings.json.bak-no-readblock-*`），因为它就是 `bypassPermissions` 下残余弹窗的唯一来源。代价要记住：**这道门没了**——文件工具与 shell 命令都可以读工作目录外的任何东西（`~/.ssh` 之类），而没装本 hook 的会话更是静默放行。想恢复就把那个键写回 `true`。

> 同类还有 `dangerousRemoval`、`denyRulesUnjudged`、`restrictedMode`、`isolatePeerMachines` 也是 `bypassImmune`。也就是说 `rm -rf /` 这类灾难命令在 `bypassPermissions` 下**照样弹**——这与项目"把灾难命令交回弹窗"的选择方向一致，不是缺陷。

> 本节开头那条 `curl` 的实测弹窗**另有原因**（当时会话是 `acceptEdits`、全局 `defaultMode` 是 `auto`，最可能是 auto 模式那层分类器），**至今未坐实**。它和本节这条的现场表现一样（hook 已 allow、窗照样弹），但别把它俩当成同一条结论。

> 写裸名 `Bash` 就覆盖所有 Bash 调用（`Bash(*)` 等价）。这里**不支持 `"*"` / `"mcp__*"` 这类通配**，会被跳过并告警，只能逐个列工具名。

**为什么写宽了风险可控：** 文档的原则是 hook 只能收紧、不能放宽——所以名单上的操作照常弹，`mkfs`、`dd if=`、删向 `/` 的 `rm` 不受影响（实测判定也没变）。不过要说清：hook 的 `ask` 一定压过 settings 的 `allow` 这一点，**文档并没有明说**，是从上面那条原则推出来的。要拿它兜底，值得自己验一次。

> 代价也要写清楚：**allow 落在哪个文件，就在哪个范围生效。** 写进项目级 `.claude/settings.json` 只影响这个项目；写进 `~/.claude/settings.json`（`node install.js --global`）就是**所有项目**。而且它是无条件放行——**如果 hook 哪天没跑起来（被卸载、崩了、没注册这个目录），这批命令就是静默通过的**。这正是 `install.js --uninstall` 会把这两条一并摘掉的原因：留着它而没有守卫，是最糟的组合。

`Bash` 和 `PowerShell` 共用同一套命令规则，判定完全一致。

**所有 MCP 服务器都在覆盖内**——会话管理、看板、终端、定时任务、浏览器预览等等，普通调用（`list_sessions`、`get_status`、`show_pane`…）直接自动审批。

> ⚠️ **hook 的 `allow` 不是万能的**：Claude Code 里有一层被登记为 `bypassImmune` 的询问，**任何权限模式、任何 hook 答案都压不住它**（本节已坐实的那条就是）。判断"会不会弹"不能只看名单。
>
> 另外不要把 `Read`/`Glob`/`Grep` 的自动审批理解成"能读工作目录外的文件"：开了 `permissions.blockReadsOutsideWorkingDirectories` 时，**文件工具**读工作目录外是硬拦截（直接报错，不弹窗），hook 放行不了。**shell 命令**则相反——拦不住一条会自己去找路径的程序，所以改成"问人"，而这个问是 `bypassImmune` 的：`bypassPermissions` 下仍然弹窗就是从这来的。两条都只能 `/add-dir` 加目录、或者关掉那个设置。

### 名单里装了什么

默认名单刻意压得很小，只装**不可逆**或**必须由人回答**的操作（`src/policy.js` 的 `DEFAULT_RULES.escalate`）：

**一、问人的工具**（`USER_INTERACTION_TOOLS`）—— `AskUserQuestion`、`ExitPlanMode`。

这些工具存在的意义就是让你填一张表再交回去：`AskUserQuestion` 是问题选项表单，`ExitPlanMode` 是计划审批卡（批准 / 驳回）。自动批准等于把该问的吞掉；更糟的是弹窗是**先渲染、后等 hook 回答**的，所以代答会让它闪一下就消失（这正是之前那个"闪"的来源之一）。**这份名单就是"什么是真正的询问"的定义**——不在这份名单里的，都不算问。

**二、灾难命令**（`CMD_POS` 锚定）—— `mkfs`、`dd if=`、fork 炸弹；以及删向 `/`、`/*`、`~`、`C:\`、`C:\Windows` 的 `rm` / `del` / `Remove-Item`。

只在**命令位置**匹配（命令开头，或 `;` `&&` `|` `(` `then` `do` 之后），所以提交信息、`echo`、文档里只是**引用**一条危险命令时不会弹。`rm -rf build`、`rm -rf node_modules` 这类日常清理**不在名单里**，直接放行。

**三、破坏性 MCP 操作**（`DESTRUCTIVE_MCP`）

```
mcp__*__delete_*         delete_session / delete_scheduled_task / delete_group
mcp__*__clear_*          clear_session
mcp__*__archive_*        archive_session
mcp__*__discard_*        discard_kept_worktree
mcp__*__clean_up_*       clean_up_worktrees
mcp__*__detach_*         detach_session
mcp__*__stop_*           stop_session
mcp__*__set_*            set_session_permission_mode / set_auto_merge / set_remote_control
```

理由是这几类会删会话、丢未提交的工作、或者给自己**提权**（`set_session_permission_mode` 直接把会话切到 `bypassPermissions`）。一个"自动批准一切"的守卫如果能静默批准这些，它就比弹窗更危险。

**四、写凭据文件**（`SECRET_FILE_PATH`）—— `Write` / `Edit` / `NotebookEdit` 落在 `.env`、`.env.local`、`.pem`、`.key`、`.p12`、`.pfx`、`.keystore` 上。悄悄覆盖一个凭据文件很难察觉、也很难挽回。（只是**读** `.env` 不在名单里——Read 改不坏东西。）

> **故意不在名单里的**：`rm -rf build`、`git push`、包发布、`curl | bash`、关机……这些确实危险，但都是日常动作。一个每次 `rm -rf build` 都要你点一下的守卫，正是这个项目要消灭的东西。
>
> **也没有 `deny` 这一档了。** 硬拒是"我问都不问你、直接说不"，误判时点不过去、没有补救路径。`rm -rf /` 现在返回 `ask` 交回原生弹窗——注意这不等于放它过去：Claude Code 文档写明 critical path 上的 `rm`/`rmdir` **没有任何 allow 规则或 PreToolUse 的 `allow` 能批准它**，所以它照样弹，只是由你决定。

> 注册分两层：`node install.js` 写项目级 `./.claude/settings.json`，`node install.js --global` 写 `~/.claude/settings.json`。**没有项目级注册的目录会用全局那份**，所以改了 matcher 记得两边都跑一次，否则别的项目还在用旧配置。`permissions.allow` 一并写入，**作用范围同样分两层**——只跑项目级 = 只有这个项目不弹 shell 授权。

### hook 拦不住的

Claude Code 的文档模型是：hook **先跑**，它的 `allow` 能跳过交互式授权提示，但只能**收紧**、不能**放宽**权限规则允许的范围。下面这几类照样会弹。看到这些弹窗属正常，不是漏授权。

- **shell 命令的授权询问** —— 这是实际最常见的"残余弹窗"，2026-09-18 已坐实（见上一节）：全局开着 `permissions.blockReadsOutsideWorkingDirectories` 时，CLI 会解析 shell 命令与内联脚本里的读操作，凡是**运行时算出来的路径**或 **shell 解析不了的命令**，就产生一条 `bypassImmune` 的询问——`bypassPermissions` 压不住，`PreToolUse` 的 `allow` 也压不住。`install.js` 写的 `Bash` / `PowerShell` allow 规则对这一层无效
- **写 `.claude/**`、`.git/**` 等受保护路径** —— Claude Code 不允许 agent 静默改写自己的权限配置。**这道门拦不住是应该的**：如果 hook 能自动批准改写权限配置，被约束的一方就能自己解除约束了。所以 `node install.js` 重新注册时总会弹一次，属正常（文档说 `bypassPermissions` 能压，但我们自己实测在 `bypassPermissions` 下它照样弹）
- **`rm` / `rmdir` 命中 critical path** —— 文档原话：没有任何 allow 规则或 PreToolUse 的 `allow` 能批准它。这也是本项目把那几条灾难命令交回弹窗、而不是假装能硬拒的原因
- **`requiresUserInteraction` 的 MCP 工具**
- **组织级把某连接器工具设成了 `ask`**
- **命中 managed deny 列表的操作**（hook 只能收紧，不能放宽）
- 启动 dev server —— `launch.json` 里那个"允许启动 xxx？"。实测 hook **能看到并且已经放行**（日志里是 `mcp__Claude_Browser__preview_start → allow`），但应用层不认。真想绕开就别用 `launch.json`，直接用命令起（`npm run launch` 走 Bash，hook 能接管）

> `AskUserQuestion` 和 `ExitPlanMode` 以前也在这张表里（"必须交互的工具"），现在它们**在名单里**——不是拦不住，而是我们主动交回弹窗。两回事。

`permissions.blockReadsOutsideWorkingDirectories` 打开时：**文件工具**读工作目录外是硬拦截（报错，不弹窗）；**shell 命令**则是一条 `bypassImmune` 的弹窗（上一节已坐实）。两种都只能 `/add-dir` 加目录、或者关掉这个设置——而**运行时算出来的路径连 `/add-dir` 也救不了**。

> 反过来说，`escalate` 走 hook 返回 `ask` 这条路，在 `bypassPermissions` 模式下**不保证**还能弹出窗来。如果你的会话可能跑在那个模式下，把名单里的规则同时写一份到 `permissions.ask` 更稳。

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
node install.js             # 注册 hook + permissions.allow 到 ./.claude/settings.json；--global 对所有项目生效
```

注册后在 Claude Code 里执行 `rm somefile`，它会被自动审批，并在日志面板里留下一条 `auto-approved` 记录。

> 日志面板是**可选的**：hook 完全独立运行，不依赖服务在线。不启动面板一样正常审批。

## 附带功能：loopback 推理网关代理（Claude Desktop 3p 模式）

日志面板启动时会顺带起一个**本地回环代理**（`gateway.enabled: true` 时），解决 Claude Desktop 3p 模式的两道校验：

1. `inferenceGatewayBaseUrl` **只接受 https 或回环 http** —— 局域网里的明文 HTTP 网关（如 `http://192.168.x.x:3000`）直接被判 invalid
2. `inferenceModels` 的 `name` **必须是 Anthropic 模型路由**（如 `claude-sonnet-5`），真实模型 ID 会被移除

代理监听 `127.0.0.1:15721`，转发到 `gateway.upstream`，并做两件事让桌面端无感切换：

- **请求改写**：把请求体里的 `model` 从 Anthropic 路由名改写成上游真实模型 ID，`apiKey` 自动注入
- **模型列表改写**：`GET /v1/models` 响应里，上游真实模型 ID 被替换回路由名，未覆盖的路由自动补上——桌面端切换模型时要拿这个名字去列表里校验，原样透传会报 "Model not found"

```
Claude Desktop ──► 127.0.0.1:15721 ──► http://192.168.50.101:3000
     model: "claude-sonnet-5"   改写    model: "deepseek-v4.1-flash"
```

### 只支持 OpenAI 协议的上游模型（协议转换）

改写 `model` 字段只能保证名字对，能不能用最终还是上游说了算。而 `GET /v1/models` 是照渠道清单拼出来的，所以列表里会出现“列在那儿但调不通”的名字——`k3` 就是这种情况：它在 `/v1/chat/completions` 上有渠道，在 `/v1/messages` 上没有，于是探针直接 404，Claude Code 判定“模型不存在”，拒绝切换并把记录回滚成 sonnet。

`gateway.openaiOnlyModels` 列出这类**只支持 OpenAI 协议**的上游模型 ID。命中时，代理把请求转成 `POST /v1/chat/completions`，再把回包（JSON 或 SSE 流）翻译回 Anthropic 形状：

```
Claude Code ──► /v1/messages  (Anthropic)  ──► /v1/chat/completions (OpenAI) ──► 上游
                ◄─ SSE: content_block_delta ◄─ data: {...choices[].delta}
```

转换覆盖 Claude Code 实际会发的形状：system、text / image / tool_use / tool_result 块、tools + tool_choice、流式 text / tool_calls / reasoning（`reasoning_content` 映射为 thinking 块并补一个合成签名，回程会把 thinking 丢掉，所以上游见不到它）。未知块类型一律丢弃而非猜测——丢字段只是让这一轮差点意思，传错字段会直接把这一轮弄坏。

桥接响应的状态码原样透传（Claude Code 靠它分支），错误体则转成 Anthropic 的 `{type:"error",error:{...}}` 形状；非桥接请求仍保持原样透传。

配置好 `config.json` 的 `gateway` 段后，一条命令把桌面端 profile 指过来：

```bash
npm run setup-3p    # 备份并改写 %LOCALAPPDATA%\Claude-3p\configLibrary\ 下的活动 profile
```

然后重启 Claude Desktop 即可。代理与日志面板同进程、同生命周期（`stop.bat` 一起停）；面板挂掉不影响 hook 审批，但代理挂了桌面端会断连。

## 配置 `config.json`

| 字段 | 说明 | 默认 |
|---|---|---|
| `port` | 日志面板端口 | `4317` |
| `host` | 日志面板绑定地址 | `127.0.0.1` |
| `historyLimit` | 面板显示多少条记录（文件里仍保留最近 5000 行，只是不再全显示） | `10` |
| `gateway.enabled` | 是否启动回环推理网关代理 | `false` |
| `gateway.port` / `gateway.host` | 代理监听地址（保持 `127.0.0.1`，否则桌面端校验不过） | `15721` / `127.0.0.1` |
| `gateway.upstream` | 真实网关地址，可带路径前缀 | — |
| `gateway.apiKey` | 注入上游的 Bearer key；留空则透传客户端的 Authorization | — |
| `gateway.modelMap` | Anthropic 路由名 → 上游真实模型 ID | `{}` |
| `gateway.openaiOnlyModels` | 只支持 OpenAI 协议（`/v1/chat/completions`）的上游模型 ID；命中时做 Anthropic ⇄ OpenAI 协议转换 | `[]` |
| `rules.escalate` | 自定义白名单规则（见下） | 见 `src/policy.js` |

> 配置文件有两层：项目根 `config.json` 和 `~/.ccapproval/config.json`，后者覆盖前者。
> 面板访问密钥首次运行自动生成到 `~/.ccapproval/secret`，链接里带它即可访问。

`rules.escalate` 就是白名单本身：加进去 = 这类操作弹窗；不写进去 = 静默自动审批。**这是唯一能产生弹窗的地方**，你的规则和内置那几类别拼在一起生效。

> 历史上还有过 `rules.deny`（硬拒）和 `rules.ask`（`escalate` 的旧名）。两个旧名字都不会静默失效：老配置里的规则会被自动接过来、并往 stderr 打一行提示让你改名/删除。

### 规则写法

放进 `rules.escalate` 就是"这也弹一下"：

```json
{ "tool": "Bash",            // 工具名正则
  "command": "\\brm\\b",     // Bash 命令正则（三选一或多选，全满足才命中）
  "path": "\\.env$",         // 文件路径正则（Write/Edit）
  "pattern": "...",          // 整个 tool_input JSON 的兜底正则
  "reason": "为什么要拦" }
```

例如想让所有 `docker` 命令都过问一下：

```json
{ "rules": { "escalate": [
  { "tool": "Bash|PowerShell", "command": "\\bdocker\\b", "reason": "docker 操作" }
] } }
```

判定顺序：**先看你的规则，再看内置规则，都没有就自动审批**。命中即交回弹窗，没有第二种结果。

> 内置那几条灾难命令只在**命令位置**匹配——命令开头，或 `;` `&&` `|` `(` `then` `do` 之后。所以提交信息、`echo`、文档里只是**引用**一条危险命令时不会弹窗。

## 日志面板

```bash
npm run launch      # 或 node src/server.js
```

打开 `http://127.0.0.1:4317/?t=<secret>`，是一张**只读**表格，没有批准/拒绝按钮：

| 时间 | 工具 | 结果 | 原因 | 操作内容 |
|---|---|---|---|---|
| 09-18 10:33:15 | Bash | 自动审批 | not on the escalate list | `npm test` |
| 09-18 10:34:02 | Bash | 交回弹窗 | delete of a critical/root path · 内置名单 | `rm -rf /` |
| 09-18 10:34:09 | AskUserQuestion | 交回弹窗 | the tool itself asks the user · 内置名单 | `AskUserQuestion: {"questions":[…]}` |

两种结果：

- **自动审批** —— 不在名单里，直接过了
- **交回弹窗** —— 在名单里（原因列会写清是哪条规则），交回 Claude Code 原生弹窗处理。这一列就是看"哪些操作我没让它自动过"

（旧日志里的 `策略拒绝` 行会显示成"策略拒绝（旧）"，那是取消 deny 之前的记录，不影响现在的判定。）

新记录会通过 SSE 实时推到页面，不用手动刷新。悬停"操作内容"可看完整 tool_input。

> **写入前会做凭据脱敏**。日志记的是工具的完整输入，不做处理的话，`curl -H "Authorization: ..."`、写 `.env`、改 `settings.json` 都会把密钥明文落盘，而面板悬停就能看到。所以 `sk-` / `ghp_` / `AKIA` / `xox` 开头的 token、`Bearer xxx`、以及 `token`/`secret`/`password`/`api_key` 这类字段的值，都会在落盘前替换成 `***REDACTED***`（见 `src/redact.js`）。误伤范围刻意压得很小——普通命令和 `author` 这类只是名字沾边的字段不会被动。

## 卸载

```bash
node install.js --uninstall        # 移除 hook 和它写的 permissions.allow（--global 对应全局）
```

## 一键启动相关文件

| 文件 | 作用 |
|---|---|
| `CCApproval.vbs` | 双击静默启动（无黑窗），推荐日常使用 |
| `start.bat` | 带控制台输出的启动（首跑自动 `npm install --omit=dev`，不拉图标的 dev 依赖） |
| `stop.bat` / `npm run stop` | 停止后台服务（按 PID 文件精确结束，含兜底扫描） |
| `scripts/launch.js` | 幂等启动器：已在运行则直接打开面板 |
| `scripts/stop.js` | 停止逻辑 |

服务在后台运行，PID 记录于 `~/.ccapproval/server.pid`，日志在 `~/.ccapproval/server.out.log`。

## 测试

```bash
npm test    # 策略引擎 67 例 + 安装脚本（配置合并 / 幂等 / 卸载不留残渣 / 旧 PermissionRequest 注册被清掉）+ 端到端（白名单升级 / 自动审批 / 交回弹窗 / 计划卡交回弹窗 / 旧注册不回答不记账 / 旧配置迁移 / 坏 payload 拒绝放行 / 脱敏）+ 网关 + 协议转换（Anthropic ⇄ OpenAI，含流式与 tool_calls）+ 图标（尺寸自检 + 免 token 供图）+ 脱敏
npm run icon  # 改完 assets/icon.svg 后重新生成 PNG/ICO（需先 npm install 装 devDependencies）
```

## 文件结构

```
src/hook.js       钩子入口（PreToolUse 判定每次工具调用，纯本地）
src/policy.js     规则引擎（escalate 白名单 + 默认自动审批，只有两种结果）
src/store.js      审计日志（history.jsonl，追加写）
src/redact.js     落盘前的凭据脱敏
src/server.js     只读日志面板（不参与任何决策）
src/dashboard.js  面板页面渲染
src/config.js     配置加载（项目级 + 用户级 + 环境变量）
src/gateway.js    回环推理网关代理（路由改写 + 模型列表改写）
src/anthropic-openai.js  Anthropic ⇄ OpenAI 协议转换（仅 openaiOnlyModels 命中时启用）
src/icon.js       图标路由（读 assets/ 里已生成的图，不做图像处理）
scripts/icon.js   从 assets/icon.svg 重新生成 PNG/ICO（npm run icon，需 devDependencies）
assets/icon.svg   图标的源文件（想换图标改它，改完 npm run icon）
assets/icon.*     生成物；面板和 README 直接读它们，运行时不碰上面那套工具链
install.js        注册/卸载 Claude Code hook 与 permissions.allow 条目
```
