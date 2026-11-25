# MYCAT

MYCAT 是装进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的**侧栏会话工作台**：把「置顶会话」做成一张带状态的待办清单，并给 agent 一组管理会话的工具（新建、改名、停止、置顶、归档、删除、恢复、查找）。

> 当前是首个公开版 1.0.0。界面目前只有中文；插件只在本机读写，不联网、不采集数据。

## 功能

- **置顶会话区**（工作区列表上方）
  - 四种状态：未进行（默认）/ 进行中（开始运行时自动）/ 等我处理（本轮结束自动）/ 卡点（只能手动标、手动清）
  - 点行首图标切换状态，悬停显示状态名与含义
  - 默认筛选「等我处理」：打开 dsh 先看这一轮已经跑完、等你拍板的置顶会话；其余状态和「全部」仍可点
  - 每行右侧带所属工作区简写：`123-A`（项目工作区）/ `900`（普通工作区）
- **工作区排序**：按名字前三位数字，整百（`000`…`900`）最前且升序，其余升序，没有数字前缀的最后；启动、新建、改名时自动重排
- **会话工具（agent tools）**：11 个，见下表
- **设置页「MYCAT」一节**：状态配色（中性灰/多彩/品牌蓝）、状态图例、通用设置、会话管理、统计、回收站
- **会话管理**：搜索、按状态/置顶/归档分 tab、批量置顶/归档/删除/恢复、删除两步确认
- **回收站**：删除的会话日志移进 `$DSH_HOME/mycat/deleted-sessions/`，可按标题找回；超过保留天数或总大小上限时自动清理最旧的
- **统计**：会话总数/存活/置顶/归档/回收站、最近 7 天新建、工作区分布
- **等我处理通知**（可选）：会话转入「等我处理」时发系统通知

## 安装

要求 dsh `0.2.2-rc.5` 及以上、`0.3.0` 以下（见 `package.json` 的 `engines.dsh`）。

从 GitHub 源码安装（npm 包尚未发布）：

```sh
dsh plugin --profile <profile> add github:linseasea/dsh-mycat
```

桌面端也可以在 **设置 → 插件** 里直接装；装完重启 dsh（或按宿主提示刷新页面）。

> **接管说明**：MYCAT 接管官方侧栏的工作区区域。bundle patch 会停用官方 `ui-workspace`，由 MYCAT 客户端副本提供 `uiWorkspace`；卸载 MYCAT 后官方侧栏自动回来。

## 快速上手

1. 在侧栏把常用的会话「置顶」，它们会集中到工作区上方的置顶区
2. 点行首的状态图标切换状态；「进行中」「等我处理」会跟着会话运行状态自动变
3. 让 agent 用工具管理会话，例如：「用 session_find 找出所有置顶但卡住的会话」「把上个会话改名成 X」
4. **设置 → 插件 → MYCAT** 里可以改配色、审核闸门、回收站保留策略和通知开关

## 会话工具

| 工具 | 能力 |
|---|---|
| `session_new` | 在指定工作区建会话、置顶、可选起第一轮；**带审核闸门**：先在卡片里展示目标工作区与完整首轮提示词，确认后才创建 |
| `session_seed` | 给已有会话发一条用户消息并起一轮 |
| `rename_session` | 改会话标题并钉住（自动标题不再覆盖） |
| `session_stop` | 停止会话当前一轮（= 侧栏停止按钮） |
| `session_archive` | 归档会话（从所有分组和置顶区移出，同时取消置顶）；运行中的会话默认拒绝，可传 `stop_activity: true` |
| `session_unarchive` | 取消归档 |
| `session_delete` | 删除会话（文件级，进回收站可恢复）；活会话先停止 + 归档，下次启动时删文件；拒绝删调用者自己和子代理会话 |
| `session_restore` | 从回收站恢复会话 |
| `session_pin` | 置顶会话（最新置顶排最前；已归档的会话需 `unarchive: true`） |
| `session_unpin` | 取消置顶 |
| `session_find` | 按标题/工作区/置顶/归档状态查找会话 id |

置顶/取消置顶/归档/删除都支持批量 `session_ids`；重复置顶、取消置顶是幂等的。

## 配置

`cordis.patch.yml` 里 `mycat` 条目的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭工作区自动排序与会话状态同步 |
| `leading` | `3` | 工作区排序取标题前几位数字 |
| `debounceMs` | `300` | 重排防抖 |
| `seedTemplate` | 内置模板 | `session_new` 不传 `seed` 时的开场白模板，占位 `{agents}` / `{path}` / `{title}` |
| `requireReview` | `true` | `session_new` 审核闸门；设 `false` 可绕过 |
| `notifyWait` | `true` | 「等我处理」通知的默认值（客户端读 prefs） |
| `trashKeepDays` | `30` | 回收站保留天数 |
| `trashMaxMB` | `200` | 回收站总大小上限（MB） |

`requireReview` / `notifyWait` / `trashKeepDays` / `trashMaxMB` 可在**设置页**修改，运行时写入 `$DSH_HOME/mycat/prefs.json` 并覆盖 bundle 默认值，不用重装。

## HTTP 接口

都挂在 dsh Connection 的鉴权范围内（与官方接口同一套登录与来源校验）：

| 接口 | 用途 |
|---|---|
| `GET /api/mycat/state` | 会话状态、UI 偏好、回收站摘要、待删队列 |
| `GET /api/mycat/sessions` | 会话总览（供设置页会话管理） |
| `POST /api/mycat/sessions/action` | 批量置顶/取消置顶/归档/取消归档/删除/恢复 |
| `GET /api/mycat/stats` | 统计面板数据 |
| `GET/POST /api/mycat/ui` | 状态配色 |
| `POST /api/mycat/session-status` | 手动设置某个会话的状态 |
| `GET/POST /api/mycat/prefs` | 运行时偏好 |
| `GET/DELETE /api/mycat/trash` | 回收站列表 / 一键清空 |
| `GET/POST /api/mycat/log` | 客户端错误上报与读取 |

## 数据文件

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/mycat/session-status.json` | 置顶会话的状态 |
| `$DSH_HOME/mycat/prefs.json` | 运行时偏好 |
| `$DSH_HOME/mycat/ui-prefs.json` | 状态配色 |
| `$DSH_HOME/mycat/deleted-sessions/` | 回收站（每个会话一个目录，含 `meta.json`） |
| `$DSH_HOME/mycat/pending-deletes.json` | 活会话的待删队列（下次启动时删除） |
| `$DSH_HOME/mycat/client-error.log` | 客户端错误日志（最近少量） |

## 兼容性与已知限制

- 客户端半是官方 `@deepseek-ai/dsh-client-ui-workspace`（`0.2.2-rc.5`，MIT）的副本 + MYCAT 增强。**dsh 升级改了官方侧栏组件后需要重新生成 `client.js`**（见下文「开发」）。
- 插件接管侧栏工作区区域。客户端初始化失败时导出空实现保底，web 界面仍能启动，但侧栏会是空的；错误写入 `/api/mycat/log` 与 `client-error.log`，此时卸载 MYCAT 即可恢复官方侧栏。
- `session_delete` 不是 dsh 的公开 API：冷会话是文件级删除（日志目录移进回收站）；活会话没有公开卸载接口，因此先停止 + 归档隐藏，下次启动 dsh 时再删文件。
- `session_new` 的审核闸门依赖宿主的 `userQuestions` 服务；服务缺失时会返回待审文案、不创建会话。
- 只在本机读写；没有网络请求，不采集数据。
- 界面目前只有中文。

## 开发

源码结构：

| 路径 | 内容 |
|---|---|
| `index.js` | Host 半：会话状态、会话工具、HTTP 接口 |
| `client.js` | 客户端半：官方侧栏副本 + MYCAT 增强（生成产物） |
| `src/mycat-block.js` | 注入到官方组件里的 MYCAT 客户端源码 |
| `src/patches.json` | 官方组件补丁（含模块 id 与当前 `client.js` 的 sha256） |
| `tools/rebuild-client.mjs` | 从本机 dsh 里的官方 `client.js` 重新生成 `client.js` |

重新生成客户端（需要本机装有 dsh，默认走 macOS 桌面端路径；也可以传官方 `client.js` 路径或用 `DSH_OFFICIAL_CLIENT` 指定）：

```sh
node tools/rebuild-client.mjs
```

自检（包清单、模块 id、client 的 sha256、敏感内容扫描、语法）：

```sh
node scripts/check.mjs
```

## 许可

MIT。`client.js` 含官方 MIT 组件的衍生代码，版权与许可声明见 [NOTICE](NOTICE)。

---

## English

MYCAT is a session workbench for DeepSeek Harness: a pinned-session area with four session states, eleven agent tools for managing sessions (create, seed, rename, stop, pin, unpin, archive, unarchive, delete, restore, find), a recoverable trash, session stats, and number-ordered workspaces. It takes over the sidebar workspace component (a patched copy of the official MIT component) and is local-only: no network calls, no telemetry. The UI is currently Chinese-only.

Install from source: `dsh plugin --profile <profile> add github:linseasea/dsh-mycat`. Requires dsh `>=0.2.2-rc.5 <0.3.0`, MIT licensed (see `NOTICE` for upstream attribution).
