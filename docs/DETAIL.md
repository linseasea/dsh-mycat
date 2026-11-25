# MYCAT 设计说明

本文描述 MYCAT 1.0.0 的实现：做什么、内部怎么分层、数据落在哪、有哪些已知限制。面向想改它或判断它靠不靠谱的人。

## 一句话

MYCAT 是 dsh 的侧栏会话工作台：置顶会话区 + 四种会话状态 + 11 个会话管理工具 + 回收站/统计，并接管官方侧栏的工作区区域。

## 架构

MYCAT 是一个 dsh bundle，分两半：

| 半 | 文件 | 职责 |
|---|---|---|
| Host | `index.js` | 会话状态机、11 个 agent 工具、`/api/mycat/*` HTTP 接口、工作区自动排序、回收站与待删队列、偏好读写 |
| Client | `client.js` | 侧栏工作区区域的完整实现（置顶区、状态图标、筛选、设置页各面板） |

### Client 为什么是「副本」

dsh 的侧栏工作区区域由一个 single 槽（`sidebar.workspaces`）提供，没有可插入行的 list 槽；要加置顶区只能接管这个槽。做法是：

1. 复制官方 `@deepseek-ai/dsh-client-ui-workspace`（MIT）的 `client.js`；
2. 用 `src/patches.json` 里的字节级补丁改模块 id、在官方组件里加插槽/参数，再在 `function WorkspaceBrowser(` 前注入 `src/mycat-block.js`；
3. bundle patch（`cordis.patch.yml`）里停用官方 `ui-workspace`，由 MYCAT 提供 `uiWorkspace`（子插槽只能有一个声明者）。

因此 `client.js` 是生成产物。dsh 升级后若官方侧栏组件变了，需要重新生成（见「构建」）。补丁偏移对不上时 `tools/rebuild-client.mjs` 会直接报错，不会产出错位的包。

### 错误边界

客户端每块增强都包了错误边界；模块工厂整体也包了 try/catch（导出空实现兜底），保证 web 界面不会因为 MYCAT 初始化失败而启动不了。错误会 `POST /api/mycat/log` 并追加到 `$DSH_HOME/mycat/client-error.log`。兜底状态下侧栏是空的——卸载 MYCAT 即可恢复官方侧栏。

## 侧栏

### 置顶会话区

- 位置：工作区列表上方；置顶会话从工作区列表里移除，取消置顶后回到原工作区。
- 顺序：按置顶先后，最新置顶在最上面。
- 每行右侧的所属工作区简写：`123-A`（项目工作区，取三位编号 + 项目字母）/ `900`（普通工作区，只取三位编号）。没有数字前缀的标题不显示。
- 顶部筛选条：全部 / 未进行 / 进行中 / 等我处理 / 卡点。默认选中「等我处理」，筛选不落盘；没有等我处理的会话时显示提示，不自动回落到「全部」。
- 状态图标点一下切换，悬停显示「状态名 · 含义」。

### 四状态

| 状态 | 形状 | 谁设置 |
|---|---|---|
| 未进行 `todo` | 虚线圈 | 默认；置顶时初始化 |
| 进行中 `doing` | 半圆 | 会话开始运行（`agent/status`）自动 |
| 等我处理 `wait` | 圈中点 | 本轮结束自动 |
| 卡点 `blocked` | 红色感叹号 | 只能手动；运行状态变化不会覆盖 |

自动状态与手动状态的区分存在 `session-status.json` 的 `auto` 字段：手动「卡点」不被自动逻辑覆盖；取消置顶时清掉该会话条目，重新置顶从「未进行」开始。

### 工作区排序

按标题前三位数字排序：整百（`000`、`100`…`900`）在最前且升序，其余数字升序，无数字前缀的最后。启动、新建工作区、改名时重排（`debounceMs` 防抖）。

### 设置页「MYCAT」

`settings.section` 插槽：

- 状态配色（中性灰 / 多彩 / 品牌蓝，只换颜色不换形状，立即生效，存 `ui-prefs.json`）
- 状态图例（4 个状态 + 含义）
- 通用设置（审核闸门、回收站保留天数/大小上限、等我处理通知）
- 会话管理（搜索、tab、批量置顶/归档/删除/恢复、两步删除、每批最多 50 条）
- 统计（总数、存活、置顶、归档、回收站、最近 7 天新建、工作区分布）
- 回收站（数量/大小/待删队列/一键清空）

## 会话工具

Agent 侧共 11 个工具。命名与参数（`session_id` / `session_ids` 省略时默认当前会话）：

| 工具 | 关键参数 | 说明 |
|---|---|---|
| `session_new` | `workspace`（id 或标题片段）、`seed`、`pin`、`title` | 建会话 + 置顶 + 可选起第一轮；带审核闸门 |
| `session_seed` | `session_id`、`text` | 发一条用户消息并驱动一轮 |
| `rename_session` | `title`、`session_id` | 走 `sessionTitle.rename()`，钉住标题 |
| `session_stop` | `session_id` | 停止当前轮；返回结构化结果，不抛原始异常 |
| `session_archive` | `session_id` / `session_ids`、`stop_activity` | 归档并取消置顶；运行中默认拒绝 |
| `session_unarchive` | `session_id` / `session_ids` | 取消归档 |
| `session_delete` | `session_id` / `session_ids`、`dry_run`、`expected_title` | 文件级删除，进回收站 |
| `session_restore` | `session_id` / `session_ids` | 从回收站恢复 |
| `session_pin` | `session_id` / `session_ids`、`unarchive` | 置顶；已归档需 `unarchive: true` |
| `session_unpin` | `session_id` / `session_ids` | 取消置顶 |
| `session_find` | `title`、`workspace`、`pinned`、`archived` | 按条件找会话 id |

### 审核闸门

`session_new` 在真正创建会话前，先经 `ctx.userQuestions.ask()` 在当前会话里弹一张卡：

- `question` 只放一句话（官方卡片对问题标题限高约 3 行，长文会被裁）；
- 完整首轮提示词放 `detail`（卡片正文区可滚动），代码块原样展示，超过 10000 字截断并标注原文总字数；
- 用户确认后才创建/置顶/起第一轮；取消返回 `{ created: false, reason: '用户取消' }`；
- 宿主没有 `userQuestions` 服务或询问失败时降级为「返回待审文案、不创建」；
- bundle config `requireReview: false` 可绕过，设置页也可改（运行时偏好）。

## 删除与回收站

dsh 没有公开的「删除会话」API，所以 MYCAT 自己做文件级处理：

- **冷会话**（本次 dsh 运行没打开过）：把会话日志目录移进 `$DSH_HOME/mycat/deleted-sessions/<时间戳>-<id>/session`，并移走投影缓存、写 `meta.json`（标题、大小、工作区、原路径）；随后清工作区账本/置顶/归档/MYCAT 状态，发 `api-session/removed` 让侧栏删行。可用 `session_restore` 移回原位置。
- **活会话**（本次运行打开过）：没有公开卸载接口，不能安全删日志。改为「停止 + 归档隐藏」，并登记到 `pending-deletes.json`，下次 dsh 启动时执行文件删除。
- 拒绝删除调用者自己与子代理会话（会让结果送不回来 / 破坏父会话血缘）。
- 回收站保留策略：超过 `trashKeepDays` 天或总大小超过 `trashMaxMB` 时自动清理最旧的；启动时和删除后都会检查。设置页可一键清空。

## HTTP 接口

全部通过 `ctx.connection.fetch.register` 挂载，与官方接口共用同一套登录鉴权与来源校验（不用不鉴权的 `webServer.register`）。见 README 的接口表；请求体都是 JSON，错误返回 `{ ok: false, error }` + 4xx/5xx。

## 数据文件

| 路径 | 说明 |
|---|---|
| `$DSH_HOME/mycat/session-status.json` | `{ version, sessions: { <sessionId>: { status, auto, updatedAt } } }` |
| `$DSH_HOME/mycat/prefs.json` | `{ version, requireReview?, notifyWait?, trashKeepDays?, trashMaxMB? }` |
| `$DSH_HOME/mycat/ui-prefs.json` | `{ version, theme: 'mono' \| 'multi' \| 'blue' }` |
| `$DSH_HOME/mycat/deleted-sessions/` | 回收站条目（`session/` + `meta.json`） |
| `$DSH_HOME/mycat/pending-deletes.json` | 待删队列 |
| `$DSH_HOME/mycat/client-error.log` | 客户端错误（最近少量） |

所有文件都用「写临时文件 + rename」的原子写；插件没有任何外部系统依赖或网络请求。

## 构建与自检

```sh
node tools/rebuild-client.mjs   # 从本机 dsh 的官方 client.js 重新生成 client.js
node scripts/check.mjs          # 包清单 / 模块 id / sha256 / 敏感内容扫描 / 语法
```

`src/patches.json` 记录官方版本（`sourceVersion`）、补丁偏移和当前 `client.js` 的 `expectedSha256`。重新生成后 sha 变化是正常的，按输出回填即可（构建脚本会自动回填）。

## 兼容性与已知限制

- `engines.dsh: >=0.2.2-rc.5 <0.3.0`。客户端副本按 `0.2.2-rc.5` 的官方组件生成；dsh 大版本升级后需要重新生成并验证。
- 接管 `sidebar.workspaces`：与其它接管同一区域的插件不能共存（先声明者生效）。卸载 MYCAT 后官方侧栏自动回来。
- 客户端兜底状态下侧栏为空，需要卸载恢复——不会自动回退到官方组件。
- 界面只有中文。
- 删除是文件级操作；活会话要等下次启动才真正删文件。
- 会话状态、偏好、回收站都只在本机；没有网络请求，不采集数据。

## 许可

MIT。客户端副本来自官方 `@deepseek-ai/dsh-client-ui-workspace`（MIT，Copyright (c) 2026 DeepSeek），上游声明与许可全文见仓库根目录 `NOTICE`。
