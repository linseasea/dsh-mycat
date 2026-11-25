/**
 * MYCAT — Host half.
 *
 * A session workbench for DeepSeek Harness:
 *
 * 1) Number-ordered workspaces: the first three digits of a workspace title are
 *    the sort key. Whole hundreds (000, 100, ...) come first in ascending order,
 *    other numbers follow ascending, and titles without a numeric prefix last.
 * 2) A pinned-session area with four states: todo (default), doing (set
 *    automatically while a turn runs), wait-for-me (set automatically when the
 *    turn finishes) and blocked (manual only). State lives in
 *    $DSH_HOME/mycat/session-status.json.
 * 3) Session management agent tools: session_new, session_seed,
 *    rename_session, session_stop, session_archive, session_unarchive,
 *    session_delete, session_restore, session_pin, session_unpin, session_find.
 *    session_new runs a review gate first: the target workspace and the full
 *    first-turn prompt are shown to the user for confirmation before anything
 *    is created.
 * 4) Host routes under /api/mycat/*, registered through the DSH connection so
 *    they share the same login and origin checks as official routes.
 *
 * The client half (client.js) takes over the sidebar workspace slot: it is a
 * patched copy of the official @deepseek-ai/dsh-client-ui-workspace (MIT, see
 * NOTICE), and cordis.patch.yml disables the official entry so only one
 * uiWorkspace provider is declared.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN_VERSION = '1.0.0'
const DOMAIN = 'workspace'
const TABLE = 'workspaces'

const SESSION_STATUSES = ['todo', 'doing', 'wait', 'blocked']
const DEFAULT_TRASH_KEEP_DAYS = 30
const DEFAULT_TRASH_MAX_MB = 200
const clientLogs = []

/**
 * 新会话的默认开场白：先把该工作区的 AGENTS.md 读进来再待命。
 * 占位符：{agents} = 工作区根目录下的 AGENTS.md，{path} = 工作区根目录，{title} = 工作区标题。
 */
const DEFAULT_SEED_TEMPLATE = [
  '开工前先读这个工作区的说明文档：{agents}（如果不存在，就看 {path} 下的 README 或目录索引）。',
  '按里面的约定工作；读完用几句话说明你读到的关键规则、这个工作区的结构和当前可做的工作，然后待命，等我发具体任务。',
].join('\n')

/**
 * 审核闸门的提示词上限：超过就截断，但明确标注原文总字数。
 * 完整提示词走卡片 `detail`（渲染在可滚动正文区、不限高），所以上限放得比标题宽得多。
 */
const REVIEW_PROMPT_LIMIT = 10000
const REVIEW_CONFIRM = '确认创建'
const REVIEW_CANCEL = '取消'

/** 正文里最长的一串反引号；代码围栏要比它长，才不会被提示词里的 ``` 提前闭合。 */
function longestBacktickRun(text) {
  let longest = 0
  let current = 0
  for (const char of text) {
    if (char === '`') {
      current += 1
      if (current > longest) longest = current
    } else {
      current = 0
    }
  }
  return longest
}

/**
 * 把「目标工作区 + 将要发给新会话的第一轮提示词」拆成提问卡的短标题与正文。
 *
 * 官方提问卡只把 `question` 当标题渲染并限高 3 行（`max-height: calc(3lh + 2px)`，实测 68px），
 * 长提示词塞进 question 会被裁掉、正文看不到（MYCAT v18 之前的真实故障）；`detail` 渲染在
 * 卡片可滚动的正文区、Markdown 不限高，所以提示词全文放 detail（代码块保证原样），
 * question 只留一句话。
 *
 * 返回：
 *   question = 卡片标题（一句话，含工作区与字数）
 *   detail   = 卡片正文（Markdown：完整提示词 + 「确认后才会创建」说明）
 *   plain    = 降级路径与工具结果里给模型/用户看的纯文本
 */
function buildSessionReview(workspace, prompt) {
  const title = String(workspace?.title ?? '').trim()
  const text = String(prompt ?? '')
  const retained = '确认后才会创建会话；在此之前不会创建任何会话。'
  if (text === '') {
    return {
      question: `确认在「${title}」创建一个不带开场白的空会话？`,
      detail: [
        '这次不带开场白：确认后只创建空会话、不起第一轮。',
        '',
        '空会话在侧栏暂时不可见，等它有第一条消息才会出现。',
        '',
        retained,
      ].join('\n'),
      plain: [
        `确认在「${title}」创建会话，并且不带开场白？`,
        '',
        '（这次不带开场白：确认后只创建空会话、不起第一轮；空会话在侧栏暂时不可见。）',
        '',
        retained,
      ].join('\n'),
    }
  }
  const truncated = text.length > REVIEW_PROMPT_LIMIT
  const shown = truncated ? text.slice(0, REVIEW_PROMPT_LIMIT) : text
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(shown) + 1))
  return {
    question: `确认在「${title}」创建会话，并发送 ${text.length} 字的第一轮提示词？`,
    detail: [
      `**第一轮提示词（共 ${text.length} 字，将原样发送）：**`,
      '',
      `${fence}text`,
      shown,
      fence,
      ...(truncated ? ['', `……（已截断，仅显示前 ${REVIEW_PROMPT_LIMIT} 字；原文共 ${text.length} 字）`] : []),
      '',
      retained,
    ].join('\n'),
    plain: [
      `确认在「${title}」创建会话，并把下面这段提示词作为第一轮发出去？`,
      '',
      shown,
      ...(truncated ? [`……（已截断，共 ${text.length} 字）`] : []),
      '',
      retained,
    ].join('\n'),
  }
}

function readOptions(config) {
  const leading = config?.leading
  const seedTemplate = typeof config?.seedTemplate === 'string' && config.seedTemplate.trim() !== ''
    ? config.seedTemplate
    : DEFAULT_SEED_TEMPLATE
  return {
    enabled: config?.enabled !== false,
    leading: Number.isInteger(leading) && leading >= 1 && leading <= 6 ? leading : 3,
    debounceMs: Number.isFinite(config?.debounceMs) && config.debounceMs >= 0 ? config.debounceMs : 300,
    seedTemplate,
    // 审核闸门（方案 B）：session_new 先通过 ctx.userQuestions 让用户确认，默认开启。
    requireReview: config?.requireReview !== false,
    // 会话转「等我处理」时是否发系统通知（客户端读 prefs.notifyWait 决定）。
    notifyWait: config?.notifyWait !== false,
    // 删除会话回收站的保留策略：超过天数或总大小上限时自动清理最旧的。
    trashKeepDays: Number.isFinite(config?.trashKeepDays) && config.trashKeepDays >= 0 ? config.trashKeepDays : DEFAULT_TRASH_KEEP_DAYS,
    trashMaxMB: Number.isFinite(config?.trashMaxMB) && config.trashMaxMB > 0 ? config.trashMaxMB : DEFAULT_TRASH_MAX_MB,
  }
}

/** 把模板占位符填成这个工作区的实际路径。 */
function renderSeed(template, workspace) {
  const root = String(workspace?.path ?? '').trim()
  return template
    .replaceAll('{agents}', root === '' ? 'AGENTS.md' : path.join(root, 'AGENTS.md'))
    .replaceAll('{path}', root === '' ? '(工作区根目录)' : root)
    .replaceAll('{title}', String(workspace?.title ?? '').trim())
}

/** 排序键：[组, 数字]；无前缀归第 3 组并排最后。 */
function rank(title, leading) {
  const text = String(title ?? '').trim()
  const matched = new RegExp(`^\\d{${leading}}`).exec(text)
  if (matched === null) return [2, Number.MAX_SAFE_INTEGER]
  const value = Number(matched[0])
  return [value % 100 === 0 ? 0 : 1, value]
}

function sortedByTitle(list, leading) {
  return [...list].sort((left, right) => {
    const a = rank(left.title, leading)
    const b = rank(right.title, leading)
    return a[0] - b[0] || a[1] - b[1]
  })
}

/** 按 id / 标题精确定位工作区，再退化为标题包含匹配。 */
function findWorkspace(registry, reference) {
  const text = String(reference ?? '').trim()
  if (text === '') return undefined
  const list = registry.list()
  return list.find((workspace) => String(workspace.id) === text)
    ?? list.find((workspace) => String(workspace.title ?? '').trim() === text)
    ?? list.find((workspace) => String(workspace.title ?? '').includes(text))
}

/**
 * 给一个会话发第一条用户消息并驱动一轮对话。
 * 走官方 prompt 通道（= GUI 里发第一条消息的同一条路），第二个参数必须是 AbortSignal。
 */
async function promptSession(ctx, sessionId, text) {
  await ctx.sessionController.prompt({
    sessionId,
    requestId: `mycat-${randomUUID()}`,
    content: [{ type: 'text', text }],
  }, new AbortController().signal)
}

/* ---------------------------------------------------------------- 会话状态 */

const DSH_HOME = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const MYCAT_DIR = path.join(DSH_HOME, 'mycat')
const SESSION_FILE = path.join(MYCAT_DIR, 'session-status.json')
// 删除会话（v14）：日志目录不直接 unlink，而是移到回收站（可人工恢复）；
// 还活着的会话没有公开卸载接口，登记到 pending-deletes.json，下次启动时再删。
const DELETE_TRASH_ROOT = path.join(MYCAT_DIR, 'deleted-sessions')
const PENDING_DELETE_FILE = path.join(MYCAT_DIR, 'pending-deletes.json')
const PROJECTION_CACHE_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')


function loadSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
    return data && typeof data.sessions === 'object' && data.sessions !== null ? data.sessions : {}
  } catch {
    return {}
  }
}

function saveSessions(sessions) {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true })
  const tmp = `${SESSION_FILE}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`)
  fs.renameSync(tmp, SESSION_FILE)
}

/* ---------------------------------------------------------------- 界面偏好 */

const UI_FILE = path.join(path.dirname(SESSION_FILE), 'ui-prefs.json')
// 运行时偏好（设置页可改，覆盖 bundle config 的默认值）：
//   requireReview / trashKeepDays / trashMaxMB
const PREFS_FILE = path.join(MYCAT_DIR, 'prefs.json')

function loadPrefs() {
  try {
    const data = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'))
    const out = {}
    if (typeof data?.requireReview === 'boolean') out.requireReview = data.requireReview
    if (typeof data?.notifyWait === 'boolean') out.notifyWait = data.notifyWait
    if (Number.isFinite(data?.trashKeepDays) && data.trashKeepDays >= 1 && data.trashKeepDays <= 3650) out.trashKeepDays = Math.round(data.trashKeepDays)
    if (Number.isFinite(data?.trashMaxMB) && data.trashMaxMB >= 1 && data.trashMaxMB <= 102400) out.trashMaxMB = Math.round(data.trashMaxMB)
    return out
  } catch {
    return {}
  }
}

function savePrefs(prefs) {
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true })
  const tmp = `${PREFS_FILE}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, ...prefs }, null, 2)}\n`)
  fs.renameSync(tmp, PREFS_FILE)
}
const UI_THEMES = ['mono', 'multi', 'blue']

function loadUi() {
  try {
    const data = JSON.parse(fs.readFileSync(UI_FILE, 'utf8'))
    return { theme: UI_THEMES.includes(data?.theme) ? data.theme : 'mono' }
  } catch {
    return { theme: 'mono' }
  }
}

function saveUi(ui) {
  fs.mkdirSync(path.dirname(UI_FILE), { recursive: true })
  const tmp = `${UI_FILE}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, ...ui }, null, 2)}\n`)
  fs.renameSync(tmp, UI_FILE)
}

/* ---------------------------------------------------------------- 删除会话 */

const isDirectory = (target) => {
  try { return fs.statSync(target).isDirectory() } catch { return false }
}
const isFile = (target) => {
  try { return fs.statSync(target).isFile() } catch { return false }
}

/** 待删队列：活会话在删除时登记，下次启动（此时会话都已离线）再执行真正的文件删除。 */
function loadPendingDeletes() {
  try {
    const data = JSON.parse(fs.readFileSync(PENDING_DELETE_FILE, 'utf8'))
    return data && typeof data.sessions === 'object' && data.sessions !== null ? data.sessions : {}
  } catch {
    return {}
  }
}

function savePendingDeletes(sessions) {
  fs.mkdirSync(path.dirname(PENDING_DELETE_FILE), { recursive: true })
  const tmp = `${PENDING_DELETE_FILE}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`)
  fs.renameSync(tmp, PENDING_DELETE_FILE)
}

/* ------------------------------------------------------------------- 排序 */

export const inject = ['workspaceRegistry', 'tools', 'sessionController', 'sessions', 'sessionTitle']

export function apply(ctx, config) {
  const options = readOptions(config)
  const registry = ctx.workspaceRegistry
  const titles = new Map()
  let timer
  let chain = Promise.resolve()
  let disposed = false

  const remember = (list) => {
    titles.clear()
    for (const workspace of list) titles.set(String(workspace.id), workspace.title)
  }

  /* ------------------------------------------------------------- 会话动作 */

  // 建会话必须走 sessionController.create（= GUI「新建会话」同一条链，会挂持久化写入器）；
  // ctx.sessions.create 造出来的是不落盘的裸会话，列表里翻不到。
  async function openSession(request = {}) {
    const target = findWorkspace(registry, request.workspace)
    if (target === undefined) throw new Error(`找不到工作区：${String(request.workspace ?? '(空)')}`)
    // 先把真正会发出去的第一轮提示词算出来：审核卡片展示的就是这段文本，不能再变。
    // 调用方给了 seed 就用它（seed: '' 表示明确不要开场白）；
    // 没给就用默认模板：让新会话先读该工作区的 AGENTS.md 再待命。
    const hasSeed = typeof request.seed === 'string'
    const text = hasSeed ? request.seed.trim() : renderSeed(options.seedTemplate, target)
    if (request.review === true) {
      const verdict = await reviewSession(request, target, text)
      if (!verdict.confirmed) {
        return { created: false, reason: verdict.reason, ...(verdict.review === undefined ? {} : { review: verdict.review }) }
      }
    }
    const created = await ctx.sessionController.create({ workspaceId: target.id })
    const sessionId = String(created?.sessionId ?? '')
    if (sessionId === '') throw new Error('sessionController.create 没有返回 sessionId')
    const pinned = request.pin !== false
    if (pinned) await registry.pinSession(sessionId)
    // DSH 侧栏不显示没有 turn 的空会话，要它看得见就得真起一轮。
    if (text !== '') await promptSession(ctx, sessionId, text)
    return {
      created: true,
      sessionId,
      workspaceId: String(target.id),
      workspace: String(target.title ?? ''),
      pinned,
      seeded: text !== '',
    }
  }

  /**
   * 审核闸门（方案 B）：不依赖 DSH 的审批开关，直接在工具里用 Host 的 ctx.userQuestions 问用户。
   * 问题会进当前会话的提问卡片；确认后才返回 confirmed，创建会话。
   * 卡片标题只放一句话（客户端对 question 限高 3 行），完整提示词放 detail（可滚动正文区）。
   * 服务不存在 / 询问失败时降级：返回待审文案，不创建会话。
   */
  async function reviewSession(request, workspace, prompt) {
    const review = buildSessionReview(workspace, prompt)
    const questions = ctx.get('userQuestions')
    if (typeof questions?.ask !== 'function') {
      return { confirmed: false, reason: '需要用户确认：当前 Host 没有 userQuestions 服务，已生成待审文案，未创建会话', review: review.plain }
    }
    try {
      const answer = await questions.ask({
        questions: [{
          id: 'mycat-session-review',
          header: '创建会话前确认',
          question: review.question,
          detail: review.detail,
          options: [
            { label: REVIEW_CONFIRM, description: `在「${String(workspace?.title ?? '').trim()}」创建会话、置顶并发送第一轮` },
            { label: REVIEW_CANCEL, description: '不创建任何会话（什么都不会发生）' },
          ],
        }],
        ...(request.agent === undefined ? {} : { agent: request.agent }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(typeof request.callId === 'string' && request.callId !== '' ? { wait: { callId: request.callId } } : {}),
      })
      const item = Array.isArray(answer?.answers) ? answer.answers.find((entry) => entry?.id === 'mycat-session-review') : undefined
      const selected = Array.isArray(item?.selected) ? item.selected : []
      const custom = typeof item?.custom === 'string' ? item.custom.trim() : ''
      if (selected.includes(REVIEW_CONFIRM) || custom === REVIEW_CONFIRM) return { confirmed: true }
      return { confirmed: false, reason: '用户取消' }
    } catch (error) {
      return { confirmed: false, reason: `需要用户确认，但询问失败：${error?.message ?? error}（未创建会话）`, review: review.plain }
    }
  }


  async function seedSession(request = {}) {
    const sessionId = String(request.sessionId ?? '')
    const text = String(request.text ?? '').trim()
    if (sessionId === '') throw new Error('缺少 sessionId')
    if (text === '') throw new Error('缺少 text')
    await promptSession(ctx, sessionId, text)
    return { sessionId, seeded: true }
  }

  // 改名写的是 user 来源的 session/title 事件，会钉住标题：自动标题不再覆盖。
  // 只能改当前 Host 里存活的会话；只落盘没打开的会话先在侧栏点开一次。
  async function renameSession(request = {}) {
    const sessionId = String(request.sessionId ?? '')
    const title = String(request.title ?? '').trim()
    if (sessionId === '') throw new Error('缺少 sessionId')
    if (title === '') throw new Error('缺少 title')
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) throw new Error(`会话不在线：${sessionId}（先在侧栏打开一次再改名）`)
    const snapshot = ctx.sessionTitle.rename(session, title)
    titleCache.delete(sessionId)
    return { sessionId, title: snapshot.title, eventSeq: snapshot.eventSeq }
  }

  // 停止 = 侧栏停止按钮同一条路：abort 正在跑的这一轮，保留排队输入（keepInbox）。
  // 只认当前 Host 里存活的会话；没在跑时 cancel 是空操作，所以先查状态，用结构化结果
  // 告诉调用方「没在跑 / 不在线」，不把原始异常抛给模型。
  async function stopSession(request = {}) {
    const sessionId = String(request.sessionId ?? '')
    if (sessionId === '') throw new Error('缺少 sessionId')
    const agent = ctx.get('agents')?.get?.(sessionId)
    if (agent === undefined) {
      return { sessionId, stopped: false, status: 'offline', message: `会话不在线：${sessionId}（没打开或已结束；在侧栏点开它再停止）` }
    }
    if (agent.status !== 'running') {
      return { sessionId, stopped: false, status: 'idle', message: `会话没有正在跑的轮次：${sessionId}` }
    }
    try {
      await ctx.sessionController.cancel({ sessionId })
    } catch (error) {
      return { sessionId, stopped: false, status: 'error', message: `停止失败：${error?.message ?? error}` }
    }
    markStopped(sessionId)
    return { sessionId, stopped: true, status: 'stopped', message: `已停止会话当前这一轮：${sessionId}` }
  }

  // 归档 = 进入 workspaceRegistry 的全局归档集：从所有分组和置顶区移出，同一次持久写入顺带取消置顶。
  // 运行中的会话默认拒绝（和界面「先停止再归档」一致）；stop_activity: true 时先写入归档（置顶同时取消），
  // 再请各提供方停止当前轮——归档集本身是 agent/pre-step 的门，停止引发的唤醒不会再跑。
  async function archiveSession(request = {}) {
    const sessionId = String(request.sessionId ?? '')
    if (sessionId === '') throw new Error('缺少 sessionId')
    const stopActivity = request.stopActivity === true
    const wasPinned = pinnedIds()?.has(sessionId) === true
    // 归档前先记下 MYCAT 有没有这个会话的状态条目：真实 Host 的 domain/changed 会在 registry
    // 写盘时同步剪枝，事后 forgetSession() 常常已经找不到，用事后结果会恒为 false。
    const hadStatus = sessions[sessionId] !== undefined
    let already = false
    try { already = (registry.archivedSessionIds ?? []).includes(sessionId) } catch {}
    if (!already) {
      try {
        await registry.archiveSession(sessionId, stopActivity ? { stopActivity: true } : {})
      } catch (error) {
        // 这两个错误类型是 workspaceRegistry 的稳定契约，翻译成可操作的中文，别把原始异常甩给模型。
        if (error?.name === 'WorkspaceActiveSessionError') throw new Error(`会话正在运行：${sessionId}（先 session_stop，或传 stop_activity: true 让归档同时停止它）`)
        if (error?.name === 'WorkspaceUnknownSessionError') throw new Error(`找不到会话：${sessionId}（归档只接受当前 Host 或已落盘存在的会话，先确认 session_id）`)
        throw new Error(`归档失败：${error?.message ?? error}`)
      }
    }
    forgetSession(sessionId)
    return { sessionId, archived: true, already, wasPinned, statusCleared: hadStatus }
  }

  // 置顶 = 官方侧栏「置顶会话」同一条路（workspaceRegistry.pinSession，最新置顶排最前）：
  // 只接受 live 或已落盘的会话、已归档的会话会拒绝；已置顶再 pin 是 no-op。
  // 置顶后 MYCAT 状态初始化为「未进行」（todo），与状态机默认值一致；已有状态（如手动卡点）不覆盖。
  async function pinSessionTool(request = {}) {
    const sessionId = String(request.sessionId ?? '').trim()
    if (sessionId === '') throw new Error('缺少 sessionId')
    const pinned = pinnedIds()
    const already = pinned === undefined ? false : pinned.has(sessionId)
    if (!already) {
      // unarchive: true 时先取消归档再置顶（v16 便利选项）。
      if (request.allowUnarchive === true && archivedIds().has(sessionId)) {
        try { await registry.unarchiveSession(sessionId) } catch (error) { throw new Error(`取消归档失败：${error?.message ?? error}`) }
      }
      try {
        await registry.pinSession(sessionId)
      } catch (error) {
        // 两个稳定错误类型翻成可操作中文，别把原始异常甩给模型。
        if (error?.name === 'WorkspaceArchivedSessionPinError') throw new Error(`会话已归档：${sessionId}（先在侧栏「全部对话（显示已归档）」里取消归档，再置顶）`)
        if (error?.name === 'WorkspaceUnknownSessionError') throw new Error(`找不到会话：${sessionId}（只接受当前 Host 或已落盘的会话；确认 session_id 后再试）`)
        throw new Error(`置顶失败：${error?.message ?? error}`)
      }
    }
    if (sessions[sessionId] === undefined) {
      sessions = { ...sessions, [sessionId]: { status: 'todo', auto: true, updatedAt: new Date().toISOString() } }
      persistSessions()
    }
    // 置顶时会话正在跑的话，让随后的 agent/status 结束事件能把它转成「等我处理」。
    if (ctx.get('agents')?.get?.(sessionId)?.status === 'running') lastRunning.set(sessionId, true)
    return { sessionId, pinned: true, already }
  }

  // 取消归档：把会话从全局归档集移出，恢复它原来的位置（未归档时是 no-op）。
  async function unarchiveSessionTool(request = {}) {
    const sessionId = String(request.sessionId ?? '').trim()
    if (sessionId === '') throw new Error('缺少 sessionId')
    const wasArchived = archivedIds().has(sessionId)
    if (!wasArchived) return { sessionId, unarchived: false, wasArchived: false }
    try {
      await registry.unarchiveSession(sessionId)
    } catch (error) {
      throw new Error(`取消归档失败：${error?.message ?? error}`)
    }
    return { sessionId, unarchived: true, wasArchived: true }
  }

  // 取消置顶：从全局置顶集移除（未置顶时是 no-op），并清掉 MYCAT 的置顶状态条目。
  async function unpinSessionTool(request = {}) {
    const sessionId = String(request.sessionId ?? '').trim()
    if (sessionId === '') throw new Error('缺少 sessionId')
    const pinned = pinnedIds()
    const already = pinned === undefined ? false : !pinned.has(sessionId)
    if (!already) {
      try {
        await registry.unpinSession(sessionId)
      } catch (error) {
        throw new Error(`取消置顶失败：${error?.message ?? error}`)
      }
    }
    // 取消置顶后会话回到工作区，重新置顶从「未进行」开始。
    forgetSession(sessionId)
    return { sessionId, pinned: false, already }
  }

  /* --------------------------------------------------- 删除会话（v14） */

  // DSH 没有任何公开的「删除会话」接口（SessionStore / sessionPersistence / 查询索引都没有 remove）：
  // 唯一安全路径是「冷会话文件级移走 + 公开 API 清账 + 通知客户端」。活会话没有公开卸载接口
  // （AgentHandle.dispose 是能力，只属于创建者），删活日志还会让后续 append 重建无 header 的文件，
  // 所以活会话只做「停止 + 归档隐藏 + 登记到下次启动时删除」。
  const sessionRoot = () => {
    const persistence = ctx.get('sessionPersistence')
    return typeof persistence?.root === 'string' ? persistence.root : path.join(DSH_HOME, 'sessions')
  }

  const sessionSnapshot = async (sessionId) => {
    const persistence = ctx.get('sessionPersistence')
    if (typeof persistence?.stat !== 'function') return undefined
    try { return await persistence.stat(sessionId) } catch { return undefined }
  }

  /** 后备定位：按 <sessionsRoot>/<cwd编码>/<id> 扫目录（backend 没给 location 时用）。 */
  function scanSessionDir(sessionId) {
    let entries
    try { entries = fs.readdirSync(sessionRoot(), { withFileTypes: true }) } catch { return [] }
    const matches = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(sessionRoot(), entry.name, sessionId)
      if (isDirectory(candidate)) matches.push(candidate)
    }
    return matches
  }

  function queuePendingDelete(sessionId, extra = {}) {
    const pending = loadPendingDeletes()
    pending[sessionId] = { queuedAt: new Date().toISOString(), ...extra }
    savePendingDeletes(pending)
  }

  /** 把会话日志目录 + 投影缓存移进 MYCAT 回收站；返回回收站目录。 */
  function moveSessionToTrash(sessionId, sessionDir, snapshot, extra = {}) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
    const target = path.join(DELETE_TRASH_ROOT, `${stamp}-${sessionId}`)
    fs.mkdirSync(target, { recursive: true })
    try {
      fs.renameSync(sessionDir, path.join(target, 'session'))
    } catch {
      // 跨文件系统时退化为复制 + 删除（同一个 $DSH_HOME 下正常不会走到）。
      fs.cpSync(sessionDir, path.join(target, 'session'), { recursive: true })
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
    const cache = path.join(PROJECTION_CACHE_DIR, `${sessionId}.json`)
    if (isFile(cache)) {
      try { fs.renameSync(cache, path.join(target, 'projection-cache.json')) } catch {
        try { fs.copyFileSync(cache, path.join(target, 'projection-cache.json')); fs.rmSync(cache, { force: true }) } catch {}
      }
    }
    fs.writeFileSync(path.join(target, 'meta.json'), `${JSON.stringify({
      version: 1,
      sessionId,
      deletedAt: new Date().toISOString(),
      sourceDir: sessionDir,
      ...(typeof extra.title === 'string' && extra.title !== '' ? { title: extra.title } : {}),
      cwd: snapshot?.header?.cwd ?? null,
      createdAt: snapshot?.header?.createdAt ?? null,
      sizeBytes: snapshot?.sizeBytes ?? null,
      wasPinned: extra.wasPinned === true,
      wasArchived: extra.wasArchived === true,
      recover: '用 session_restore 工具恢复（会把 session/ 移回 sourceDir；工作区归属/置顶/归档尽量恢复）',
    }, null, 2)}\n`)
    return target
  }

  /** 从工作区账本里摘掉会话（公开实体方法，幂等且不碰会话日志）。 */
  async function detachFromWorkspaces(sessionId) {
    const detached = []
    let workspaces
    try { workspaces = registry.list() } catch { return detached }
    for (const workspace of workspaces) {
      let ids
      try { ids = (workspace?.sessionIds ?? []).map(String) } catch { continue }
      if (!ids.includes(sessionId)) continue
      try {
        await workspace.detachSession(sessionId)
        detached.push(String(workspace.id))
      } catch (error) {
        console.warn(`[mycat] 会话 ${sessionId} 从工作区 ${workspace?.id} 摘除失败：`, error?.message ?? error)
      }
    }
    return detached
  }

  /**
   * 删除一个会话。
   * - 冷会话（本次 DSH 没打开过）：立即删——日志目录移进回收站，清工作区账本/置顶/归档/MYCAT 状态，
   *   再发 api-session/removed 让侧栏立刻移除该行。
   * - 活会话：没有公开卸载接口，不能安全删日志（会被后续 append 重建坏文件）；改为停止 + 归档隐藏，
   *   并登记到 pending-deletes.json，下次启动 DSH 时再执行文件删除。
   */
  async function deleteSession(request = {}) {
    const sessionId = String(request.sessionId ?? '').trim()
    if (sessionId === '') throw new Error('缺少 sessionId')
    const callerId = String(request.callerId ?? '')
    if (callerId !== '' && sessionId === callerId) {
      return { deleted: false, sessionId, queued: false, reason: '不能删除正在执行这条指令的会话（会中断自己，结果也送不回来）；请从另一个会话发起' }
    }
    const expectedTitle = String(request.expectedTitle ?? '').trim()
    const dryRun = request.dryRun === true
    const live = ctx.get('agents')?.get?.(sessionId) ?? ctx.sessions.get(sessionId)
    let title = ''
    if (expectedTitle !== '' || dryRun) {
      title = await readTitleOf(sessionId)
      if (expectedTitle !== '' && title === '') throw new Error(`无法读取会话标题，不能校验 expected_title：${sessionId}（去掉 expected_title，或先用 session_find 确认）`)
      if (expectedTitle !== '' && title !== expectedTitle) throw new Error(`标题校验不通过：${sessionId} 的实际标题是「${title}」，不是「${expectedTitle}」；已中止`)
    }
    if (dryRun) {
      return {
        deleted: false,
        dryRun: true,
        sessionId,
        live: live !== undefined,
        title: title === '' ? null : title,
        reason: live !== undefined
          ? '会话仍在线：真实删除会先停止 + 归档隐藏，并登记到下次启动时删文件'
          : '冷会话：真实删除会把日志目录移进回收站（可用 session_restore 恢复）',
      }
    }
    if (live !== undefined) {
      // 活会话：停止其工作并归档隐藏（归档会同时取消置顶），再登记为待删。
      const wasPinnedBefore = pinnedIds()?.has(sessionId) === true
      const wasArchivedBefore = archivedIds().has(sessionId)
      let archived = false
      let archiveError
      try {
        await registry.archiveSession(sessionId, { stopActivity: true })
        archived = true
      } catch (error) {
        archiveError = error?.message ?? String(error)
        try {
          const agent = ctx.get('agents')?.get?.(sessionId)
          if (agent?.status === 'running') agent.cancel({ kind: 'user' })
        } catch {}
      }
      forgetSession(sessionId)
      queuePendingDelete(sessionId, {
        reason: 'live',
        archived,
        wasPinned: request.wasPinned === undefined ? wasPinnedBefore : request.wasPinned === true,
        wasArchived: request.wasArchived === undefined ? wasArchivedBefore : request.wasArchived === true,
      })
      return {
        deleted: false,
        sessionId,
        queued: true,
        archived,
        reason: `会话仍在线（本次 DSH 运行中打开过），没有公开的卸载接口：已${archived ? '停止其工作并归档隐藏' : '停止正在跑的一轮'}，并登记为待删；下次启动 DSH 时会自动删除它的日志文件${archived ? '' : `（归档失败：${archiveError ?? '未知错误'}）`}。`,
      }
    }

    // 冷会话：拿 header/location 做存在性校验和子代理保护。
    const snapshot = await sessionSnapshot(sessionId)
    let sessionDir = typeof snapshot?.location?.path === 'string' ? path.dirname(snapshot.location.path) : undefined
    if (sessionDir === undefined) {
      const candidates = scanSessionDir(sessionId)
      if (candidates.length > 1) throw new Error(`找到多个同名会话目录，已中止：${sessionId}`)
      sessionDir = candidates[0]
    }
    if (snapshot === undefined && sessionDir === undefined) throw new Error(`找不到会话：${sessionId}（可能已删除，或 session_id 写错）`)
    if (snapshot?.header?.origin === 'subagent') throw new Error(`子代理会话不删除：${sessionId}（会破坏父会话血缘；如需隐藏请用归档）`)
    if (sessionDir === undefined || !isDirectory(sessionDir)) throw new Error(`找不到会话的日志目录：${sessionId}（可能已被外部移走）`)
    if (path.basename(sessionDir) !== sessionId) throw new Error(`会话目录不符合预期，已中止：${sessionDir}`)
    if (sessionLockedElsewhere(sessionDir)) throw new Error(`会话日志正被其它进程占用，已中止：${sessionId}（先在其它 DSH 实例/终端里关闭它再删）`)

    const wasPinnedBefore = pinnedIds()?.has(sessionId) === true
    const wasArchivedBefore = archivedIds().has(sessionId)

    // 先清 DSH 账目（公开 API，幂等）→ 再移日志 → 最后通知客户端。
    const workspaces = await detachFromWorkspaces(sessionId)
    try { await registry.unpinSession(sessionId) } catch (error) { console.warn('[mycat] 取消置顶失败：', error?.message ?? error) }
    try { await registry.unarchiveSession(sessionId) } catch (error) { console.warn('[mycat] 取消归档失败：', error?.message ?? error) }
    const statusCleared = forgetSession(sessionId)

    const titleForMeta = title !== '' ? title : await readTitleOf(sessionId)
    let trashedTo
    try {
      trashedTo = moveSessionToTrash(sessionId, sessionDir, snapshot, {
        title: titleForMeta,
        wasPinned: request.wasPinned === undefined ? wasPinnedBefore : request.wasPinned === true,
        wasArchived: request.wasArchived === undefined ? wasArchivedBefore : request.wasArchived === true,
      })
    } catch (error) {
      throw new Error(`删除失败：日志目录移动出错：${error?.message ?? error}（会话未删除；置顶/归档/工作区归属已清理，可重试）`)
    }

    // 联动清理：指向该会话的定时任务（公开 schedule 能力）+ 回收站保留策略。
    const schedules = await stopSchedulesFor(sessionId)
    const warnings = [...schedules.warnings, ...mobileResidue(sessionId)]
    try { pruneTrash() } catch (error) { warnings.push(`清理回收站失败：${error?.message ?? error}`) }

    // api-session/removed 只在会话真的不存在后发：活会话不能发（会让客户端输入框永久置灰）。
    if (typeof ctx.emit === 'function') ctx.emit('api-session/removed', sessionId)
    return { deleted: true, sessionId, queued: false, trashedTo, workspaces, statusCleared, schedulesStopped: schedules.stopped, warnings }
  }

  /** 处理 pending-deletes.json：启动后（此时通常没有 live 会话）把上次登记的活会话真正删掉。 */
  let flushingDeletes = false
  async function flushPendingDeletes() {
    if (flushingDeletes) return
    const pending = loadPendingDeletes()
    const ids = Object.keys(pending)
    if (ids.length === 0) return
    flushingDeletes = true
    const keep = {}
    try {
      for (const id of ids) {
        try {
          const result = await deleteSession({
            sessionId: id,
            queued: true,
            ...(pending[id]?.wasPinned === undefined ? {} : { wasPinned: pending[id].wasPinned }),
            ...(pending[id]?.wasArchived === undefined ? {} : { wasArchived: pending[id].wasArchived }),
          })
          if (result?.deleted === true) console.log(`[mycat] 已删除待删会话 ${id}`)
          else keep[id] = pending[id]
        } catch (error) {
          keep[id] = pending[id]
          console.warn(`[mycat] 待删会话 ${id} 删除失败：`, error?.message ?? error)
        }
      }
      savePendingDeletes(keep)
    } finally {
      flushingDeletes = false
    }
  }

  /** 启动后延迟执行待删队列：等 sessionPersistence / workspaceRegistry 就绪；定时器随插件卸载清理。 */
  const pendingFlushTimers = new Set()
  function schedulePendingDeleteFlush(delay = 1500) {
    const timer = setTimeout(() => {
      pendingFlushTimers.delete(timer)
      void flushPendingDeletes().catch((error) => console.warn('[mycat] 待删会话队列处理失败：', error?.message ?? error))
    }, delay)
    pendingFlushTimers.add(timer)
  }

  ctx.effect(() => () => {
    for (const timer of pendingFlushTimers) clearTimeout(timer)
    pendingFlushTimers.clear()
  })


  /* ------------------------------------------- 查找 / 回收站 / 批量（v16） */

  /** 读取一批会话的标题（冷会话也可读；失败静默，不阻塞其它能力）。 */
  const titleCache = new Map()
  const TITLE_CACHE_MS = 30_000
  async function readTitles(ids) {
    const out = new Map()
    if (ids.length === 0) return out
    const now = Date.now()
    const missing = []
    for (const raw of ids) {
      const id = String(raw)
      const cached = titleCache.get(id)
      if (cached !== undefined && now - cached.at < TITLE_CACHE_MS) out.set(id, cached.title)
      else missing.push(id)
    }
    if (missing.length > 0) {
      const query = ctx.get('sessionQuery')
      let resolved = false
      if (typeof query?.readTitleSnapshots === 'function') {
        try {
          const results = await query.readTitleSnapshots(missing)
          for (const item of results) {
            if (item?.status === 'fulfilled') {
              const title = item.value?.title?.title ?? ''
              out.set(String(item.sessionId), title)
              titleCache.set(String(item.sessionId), { title, at: now })
            }
          }
          resolved = true
        } catch (error) {
          console.warn('[mycat] 读取会话标题失败：', error?.message ?? error)
        }
      }
      if (!resolved) {
        for (const id of missing) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(PROJECTION_CACHE_DIR, `${id}.json`), 'utf8'))
            const title = data?.record?.rows?.title?.val
            if (typeof title === 'string') { out.set(id, title); titleCache.set(id, { title, at: now }) }
          } catch {}
        }
      }
    }
    return out
  }

  async function readTitleOf(sessionId) {
    const titles = await readTitles([sessionId])
    return titles.get(sessionId) ?? ''
  }

  /** live 优先的完整会话清单：sessionQuery.listSessions，退化到 persistence.list。 */
  async function listSessionRecords() {
    const query = ctx.get('sessionQuery')
    if (typeof query?.listSessions === 'function') {
      try { return await query.listSessions() } catch (error) { console.warn('[mycat] 列会话失败：', error?.message ?? error) }
    }
    const persistence = ctx.get('sessionPersistence')
    if (typeof persistence?.list === 'function') {
      try {
        const snapshots = await persistence.list()
        return snapshots.map((snapshot) => ({ header: snapshot.header, live: false, persisted: true }))
      } catch (error) { console.warn('[mycat] 列会话失败：', error?.message ?? error) }
    }
    return []
  }

  /** 会话 id → 所属工作区（registry 的会话账本；不归属任何工作区则无）。 */
  function workspaceBySession() {
    const map = new Map()
    let list = []
    try { list = registry.list() } catch {}
    for (const workspace of list) {
      let ids = []
      try { ids = (workspace?.sessionIds ?? []).map(String) } catch {}
      for (const id of ids) if (!map.has(id)) map.set(id, workspace)
    }
    return map
  }

  /** session_find：按标题/关键词/工作区/置顶/归档状态找会话 id。 */
  async function findSessions(request = {}) {
    const queryText = String(request.query ?? '').trim().toLowerCase()
    const wantedWorkspace = String(request.workspace ?? '').trim().toLowerCase()
    const pinnedFilter = request.pinned === true ? true : request.pinned === false ? false : undefined
    const archivedFilter = request.archived === true ? true : request.archived === false ? false : undefined
    const limit = Number.isInteger(request.limit) ? Math.min(Math.max(request.limit, 1), 100) : 20
    const records = await listSessionRecords()
    const workspaces = workspaceBySession()
    const pinned = pinnedIds() ?? new Set()
    const archived = archivedIds()
    let candidates = records.map((record) => {
      const header = record?.header ?? {}
      return {
        sessionId: String(header.id ?? ''),
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        createdAt: Number(header.createdAt ?? 0) || null,
        live: record?.live === true,
      }
    }).filter((item) => item.sessionId !== '')
    const idMatched = new Set()
    if (queryText !== '') {
      for (const item of candidates) if (item.sessionId.toLowerCase().includes(queryText)) idMatched.add(item.sessionId)
    }
    if (wantedWorkspace !== '') {
      candidates = candidates.filter((item) => {
        const workspace = workspaces.get(item.sessionId)
        const title = String(workspace?.title ?? '').toLowerCase()
        const id = String(workspace?.id ?? '').toLowerCase()
        return title.includes(wantedWorkspace) || id === wantedWorkspace || item.cwd.toLowerCase().includes(wantedWorkspace)
      })
    }
    if (pinnedFilter !== undefined) candidates = candidates.filter((item) => pinned.has(item.sessionId) === pinnedFilter)
    if (archivedFilter !== undefined) candidates = candidates.filter((item) => archived.has(item.sessionId) === archivedFilter)
    const titles = await readTitles(candidates.map((item) => item.sessionId))
    const matched = []
    for (const item of candidates) {
      const title = titles.get(item.sessionId) ?? ''
      const workspace = workspaces.get(item.sessionId)
      const workspaceTitle = String(workspace?.title ?? '')
      if (queryText !== '' && !idMatched.has(item.sessionId)) {
        const haystack = `${title}\n${workspaceTitle}`.toLowerCase()
        if (!haystack.includes(queryText)) continue
      }
      matched.push({
        sessionId: item.sessionId,
        ...(title === '' ? {} : { title }),
        ...(workspace === undefined ? {} : { workspaceId: String(workspace.id) }),
        ...(workspaceTitle === '' ? {} : { workspace: workspaceTitle }),
        live: item.live,
        pinned: pinned.has(item.sessionId),
        archived: archived.has(item.sessionId),
      })
    }
    // truncated 只表示「真实匹配数超过 limit」，不因 query/其它过滤而误报。
    const truncated = matched.length > limit
    const sessions = matched.slice(0, limit)
    return { ok: true, sessions, total: matched.length, limit, truncated }
  }

  /** 会话管理面板用：全部会话 + 标题/工作区/置顶/归档/运行中/状态。 */
  async function sessionsOverview() {
    const records = await listSessionRecords()
    const workspaces = workspaceBySession()
    const pinned = pinnedIds() ?? new Set()
    const archived = archivedIds()
    const agents = ctx.get('agents')
    const base = []
    for (const record of records) {
      const header = record?.header ?? {}
      const sessionId = String(header.id ?? '')
      if (sessionId === '') continue
      base.push({
        sessionId,
        createdAt: Number(header.createdAt ?? 0) || undefined,
        live: record?.live === true,
      })
    }
    const titles = await readTitles(base.map((item) => item.sessionId))
    return base.map((item) => {
      const workspace = workspaces.get(item.sessionId)
      const entry = sessions[item.sessionId]
      return {
        sessionId: item.sessionId,
        ...(titles.get(item.sessionId) ? { title: titles.get(item.sessionId) } : {}),
        ...(workspace === undefined ? {} : { workspaceId: String(workspace.id), workspace: String(workspace.title ?? '') }),
        ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
        live: item.live,
        pinned: pinned.has(item.sessionId),
        archived: archived.has(item.sessionId),
        running: agents?.get?.(item.sessionId)?.status === 'running',
        ...(entry?.status === undefined ? {} : { status: entry.status }),
      }
    })
  }

  /** 统计面板用：总量 / 7 天新增 / 运行中 / 置顶 / 归档 / 回收站 / 等我处理 / 工作区分布。 */
  async function statsOverview() {
    const records = await listSessionRecords()
    const workspaces = workspaceBySession()
    const pinned = pinnedIds() ?? new Set()
    const archived = archivedIds()
    const now = Date.now()
    let last7daysNew = 0
    let live = 0
    const perWorkspace = new Map()
    for (const record of records) {
      const header = record?.header ?? {}
      const sessionId = String(header.id ?? '')
      if (sessionId === '') continue
      const createdAt = Number(header.createdAt ?? 0) || 0
      if (createdAt > 0 && now - createdAt <= 7 * 86400_000) last7daysNew += 1
      if (record?.live === true) live += 1
      const workspace = workspaces.get(sessionId)
      const name = workspace === undefined ? '未分组' : String(workspace.title ?? '未分组')
      perWorkspace.set(name, (perWorkspace.get(name) ?? 0) + 1)
    }
    const entries = Object.values(sessions)
    const trash = trashSummary()
    const top = [...perWorkspace.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([title, count]) => ({ title, count }))
    return {
      ok: true,
      total: records.length,
      live,
      pinned: pinned.size,
      archived: archived.size,
      trashCount: trash.count,
      trashBytes: trash.bytes,
      pendingDeletes: Object.keys(loadPendingDeletes()).length,
      last7daysNew,
      waitAuto: entries.filter((entry) => entry?.status === 'wait' && entry?.auto === true).length,
      blocked: entries.filter((entry) => entry?.status === 'blocked').length,
      workspaces: top,
    }
  }

  /* ------------------------------ 回收站 ------------------------------ */

  const trashDirs = () => {
    let entries = []
    try { entries = fs.readdirSync(DELETE_TRASH_ROOT, { withFileTypes: true }) } catch { return [] }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(DELETE_TRASH_ROOT, entry.name))
  }

  const trashDirSize = (dir) => {
    let total = 0
    const stack = [dir]
    while (stack.length > 0) {
      const current = stack.pop()
      let entries = []
      try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        const target = path.join(current, entry.name)
        if (entry.isDirectory()) stack.push(target)
        else if (entry.isFile()) { try { total += fs.statSync(target).size } catch {} }
      }
    }
    return total
  }

  const readTrashMeta = (dir) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) } catch { return {} }
  }

  function trashSummary() {
    const entries = trashDirs().map((dir) => {
      const meta = readTrashMeta(dir)
      return {
        dir,
        sessionId: String(meta.sessionId ?? path.basename(dir).replace(/^\d{14}-/, '')),
        title: typeof meta.title === 'string' && meta.title !== '' ? meta.title : null,
        deletedAt: typeof meta.deletedAt === 'string' ? meta.deletedAt : null,
        sizeBytes: Number.isFinite(meta.sizeBytes) ? meta.sizeBytes : trashDirSize(dir),
      }
    }).sort((a, b) => String(b.deletedAt ?? '').localeCompare(String(a.deletedAt ?? '')))
    const bytes = entries.reduce((sum, entry) => sum + (entry.sizeBytes || 0), 0)
    return {
      count: entries.length,
      bytes,
      entries: entries.map((entry) => ({
        sessionId: entry.sessionId,
        ...(entry.title === null ? {} : { title: entry.title }),
        deletedAt: entry.deletedAt,
        sizeBytes: entry.sizeBytes,
      })),
    }
  }

  /** 按保留天数 / 总大小上限清理回收站（旧的先删）；返回清掉的条目数。 */
  function pruneTrash() {
    const dirs = trashDirs().map((dir) => {
      const meta = readTrashMeta(dir)
      return { dir, deletedAt: Date.parse(String(meta.deletedAt ?? '')) || 0, sizeBytes: Number.isFinite(meta.sizeBytes) ? meta.sizeBytes : trashDirSize(dir) }
    }).sort((a, b) => a.deletedAt - b.deletedAt)
    let removed = 0
    const now = Date.now()
    const limits = trashLimits()
    const keepAfter = limits.keepDays <= 0 ? now + 1 : now - limits.keepDays * 86400_000
    const maxBytes = limits.maxBytes
    let total = dirs.reduce((sum, entry) => sum + entry.sizeBytes, 0)
    for (const entry of dirs) {
      const tooOld = entry.deletedAt !== 0 && entry.deletedAt < keepAfter
      const tooBig = total > maxBytes
      if (!tooOld && !tooBig) continue
      try { fs.rmSync(entry.dir, { recursive: true, force: true }); total -= entry.sizeBytes; removed += 1 } catch {}
    }
    return removed
  }

  function clearTrash() {
    let removed = 0
    for (const dir of trashDirs()) {
      try { fs.rmSync(dir, { recursive: true, force: true }); removed += 1 } catch {}
    }
    return removed
  }

  const findTrashDir = (sessionId) => {
    let best
    for (const dir of trashDirs()) {
      const meta = readTrashMeta(dir)
      const id = String(meta.sessionId ?? path.basename(dir).replace(/^\d{14}-/, ''))
      if (id !== sessionId) continue
      const at = Date.parse(String(meta.deletedAt ?? '')) || 0
      if (best === undefined || at > best.at) best = { dir, meta, at }
    }
    return best
  }

  /** 把回收站里的会话移回原位置，并尽量恢复工作区归属 / 置顶 / 归档状态。 */
  async function restoreSession(request = {}) {
    const sessionId = String(request.sessionId ?? '').trim()
    if (sessionId === '') throw new Error('缺少 sessionId')
    const found = findTrashDir(sessionId)
    if (found === undefined) throw new Error(`回收站里没有会话：${sessionId}`)
    const sourceDir = String(found.meta.sourceDir ?? '')
    if (sourceDir === '') throw new Error(`回收站条目缺少 sourceDir：${sessionId}（meta.json 损坏）`)
    if (isDirectory(sourceDir)) throw new Error(`还原目标已存在：${sourceDir}（先移走现有目录再恢复）`)
    const sessionBackup = path.join(found.dir, 'session')
    if (!isDirectory(sessionBackup)) throw new Error(`回收站条目缺少 session/：${found.dir}`)
    fs.mkdirSync(path.dirname(sourceDir), { recursive: true })
    fs.renameSync(sessionBackup, sourceDir)
    const cacheBackup = path.join(found.dir, 'projection-cache.json')
    if (isFile(cacheBackup)) {
      try { fs.mkdirSync(PROJECTION_CACHE_DIR, { recursive: true }); fs.renameSync(cacheBackup, path.join(PROJECTION_CACHE_DIR, `${sessionId}.json`)) } catch {}
    }
    const warnings = []
    let workspaceRestored = false
    const cwd = String(found.meta.cwd ?? '')
    let workspace
    if (cwd !== '') {
      try { workspace = registry.list().find((candidate) => String(candidate.path ?? '') === cwd) } catch {}
    }
    if (workspace !== undefined) {
      try { await workspace.attachSession(sessionId); workspaceRestored = true } catch (error) { warnings.push(`恢复工作区归属失败：${error?.message ?? error}`) }
    }
    let pinnedRestored = false
    let archivedRestored = false
    if (found.meta.wasArchived === true) {
      try { await registry.archiveSession(sessionId); archivedRestored = true } catch (error) { warnings.push(`恢复归档状态失败：${error?.message ?? error}`) }
    } else if (found.meta.wasPinned === true) {
      try { await registry.pinSession(sessionId); pinnedRestored = true } catch (error) { warnings.push(`恢复置顶失败：${error?.message ?? error}`) }
    }
    try { fs.rmSync(found.dir, { recursive: true, force: true }) } catch {}
    lastRestored = { sessionId, at: Date.now() }
    return { ok: true, sessionId, restored: true, sourceDir, workspaceRestored, pinnedRestored, archivedRestored, warnings }
  }

  /* ------------------------------ 删除辅助 ------------------------------ */

  /** 尽力取消指向该会话的定时任务（schedule 公开能力；失败只记录警告）。 */
  async function stopSchedulesFor(sessionId) {
    const scheduleService = ctx.get('schedule')
    if (scheduleService === undefined) return { stopped: 0, warnings: [] }
    try {
      let tasks = []
      if (typeof scheduleService.catalog === 'function') tasks = await scheduleService.catalog()
      const matching = tasks.filter((task) => {
        const target = task?.target
        if (target?.kind === 'session' && String(target.sessionId ?? '') === sessionId) return true
        const involved = Array.isArray(task?.involvedSessionIds) ? task.involvedSessionIds.map(String) : []
        return involved.includes(sessionId)
      })
      if (matching.length === 0) return { stopped: 0, warnings: [] }
      if (typeof scheduleService.stopSessionTasks === 'function') {
        await scheduleService.stopSessionTasks(sessionId)
        return { stopped: matching.length, warnings: [] }
      }
      return { stopped: 0, warnings: [`有 ${matching.length} 个定时任务指向该会话，但没有可用的停止接口，请手动处理`] }
    } catch (error) {
      return { stopped: 0, warnings: [`清理定时任务失败：${error?.message ?? error}`] }
    }
  }

  /** 第三方插件（mobile）是否还留着该会话的统计/回执（只报告，不改）。 */
  function mobileResidue(sessionId) {
    const warnings = []
    for (const name of ['read-receipts.json', 'mobile-stats.json']) {
      try {
        if (fs.readFileSync(path.join(DSH_HOME, name), 'utf8').includes(sessionId)) warnings.push(`${name} 里仍有该会话记录（第三方 mobile 插件，未改动）`)
      } catch {}
    }
    return warnings
  }

  /** 会话日志是否被其它进程占用（mkOS/Linux 用 lsof 探测 session.lock；失败视为未占用）。 */
  function sessionLockedElsewhere(sessionDir) {
    const lock = path.join(sessionDir, 'session.lock')
    if (!isFile(lock)) return false
    if (process.platform !== 'darwin' && process.platform !== 'linux') return false
    try {
      const result = spawnSync('lsof', ['-t', lock], { encoding: 'utf8', timeout: 3000 })
      if (result.error !== undefined) return false
      return result.status === 0 && String(result.stdout ?? '').trim() !== ''
    } catch { return false }
  }

  /* ------------------------------ 批量 ------------------------------ */

  /** 解析单/批量目标：session_ids 数组优先；单 id 可省略 = 当前会话（allowDefault）。 */
  function resolveTargets(args = {}, exec, { allowDefault = true } = {}) {
    const list = Array.isArray(args.session_ids) ? args.session_ids.map((value) => String(value ?? '').trim()).filter(Boolean) : []
    if (list.length > 0) return { ids: [...new Set(list)], batch: list.length > 1 }
    const single = String(args.session_id ?? (allowDefault ? exec?.agent?.session?.id : '') ?? '').trim()
    if (single === '') throw new Error('缺少 session_id（或 session_ids）')
    return { ids: [single], batch: false }
  }

  async function runBatch(ids, operation) {
    const results = []
    for (const id of ids) {
      try {
        results.push({ ok: true, ...(await operation(id)) })
      } catch (error) {
        results.push({ ok: false, sessionId: id, error: error?.message ?? String(error) })
      }
    }
    const succeeded = results.filter((item) => item.ok === true).length
    return { ok: true, results, total: results.length, succeeded, failed: results.length - succeeded }
  }

  // 批量输出 schema：单条与批量共用（required 只有 ok；未用字段省略）。
  const OUTPUT_FIELD_PROPERTIES = {
    ok: { type: 'boolean' },
    sessionId: { type: 'string' },
    error: { type: 'string' },
    reason: { type: 'string' },
    pinned: { type: 'boolean' },
    already: { type: 'boolean' },
    archived: { type: 'boolean' },
    unarchived: { type: 'boolean' },
    wasArchived: { type: 'boolean' },
    wasPinned: { type: 'boolean' },
    deleted: { type: 'boolean' },
    queued: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    title: { type: 'string' },
    live: { type: 'boolean' },
    trashedTo: { type: 'string' },
    sourceDir: { type: 'string' },
    restored: { type: 'boolean' },
    workspaceRestored: { type: 'boolean' },
    pinnedRestored: { type: 'boolean' },
    archivedRestored: { type: 'boolean' },
    workspaces: { type: 'array', items: { type: 'string' } },
    statusCleared: { type: 'boolean' },
    schedulesStopped: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'string' } },
  }
  function batchOutputSchema() {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: {
        ...OUTPUT_FIELD_PROPERTIES,
        results: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ...OUTPUT_FIELD_PROPERTIES } } },
        total: { type: 'integer' },
        succeeded: { type: 'integer' },
        failed: { type: 'integer' },
      },
    }
  }
  function batchRender(singleText, batchDetail) {
    return (_args, value) => {
      if (!Array.isArray(value?.results)) return [{ type: 'text', text: singleText(value) }]
      const lines = value.results.map((item) => {
        if (item.ok === false) return `- ${item.sessionId}: 失败 — ${item.error ?? '未知错误'}`
        return `- ${item.sessionId}: ${batchDetail(item)}`
      })
      return [{ type: 'text', text: [`批量结果：成功 ${value.succeeded} / 失败 ${value.failed}`, ...lines].join('\n') }]
    }
  }

  if (typeof ctx.tools?.register === 'function') {
    const sessionOutcome = {
      type: 'object',
      additionalProperties: false,
      required: ['created'],
      properties: {
        created: { type: 'boolean' },
        sessionId: { type: 'string' },
        workspaceId: { type: 'string' },
        workspace: { type: 'string' },
        pinned: { type: 'boolean' },
        seeded: { type: 'boolean' },
        reason: { type: 'string' },
        review: { type: 'string' },
      },
    }
    ctx.effect(() => {
      const disposers = [
        ctx.tools.register({
          name: 'session_new',
          description: 'Create a Session in a Workspace of this profile, pin it to the top of the sidebar, and start its first turn. A review gate runs first: the user is asked (in the calling Session) to confirm the target workspace and the complete first-turn prompt, and nothing is created until they approve; rejecting returns created:false with reason "用户取消". The gate is on by default and can be bypassed with the requireReview config. By default the first message is a fixed opening instruction telling the new Session to read that workspace AGENTS.md before waiting for tasks; pass seed to replace it, or seed:"" to create it with no message (the Session then stays hidden from the sidebar).',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['workspace'],
            properties: {
              workspace: { type: 'string', description: 'Workspace title as shown in the sidebar (for example "200-探索"), or its workspace id.' },
              pin: { type: 'boolean', description: 'Pin the new Session to the top of the sidebar. Defaults to true.' },
              seed: { type: 'string', description: 'Optional first user message that replaces the default opening instruction. Omit it to use the default (read the workspace AGENTS.md, summarize the rules, then wait). Pass an empty string to create the Session without any message.' },
            },
          },
          output: {
            schema: sessionOutcome,
            render: (_args, value) => [{
              type: 'text',
              text: value.created === true
                ? `Created session ${value.sessionId} in "${value.workspace}"${value.pinned ? ', pinned' : ''}${value.seeded ? ', first turn started' : ', left empty (hidden from the sidebar until it has a turn)'}.`
                : `No session was created: ${value.reason}${value.review === undefined ? '' : `\n\nPending review text:\n${value.review}`}`,
            }],
          },
          // 审核闸门：把真正会发出去的首轮提示词先交给用户确认；确认后才创建、置顶、起第一轮。
          execute: (args, exec) => openSession({
            ...args,
            review: reviewEnabled(),
            agent: exec?.agent,
            signal: exec?.signal,
            callId: exec?.callId,
          }),
        }),
        ctx.tools.register({
          name: 'session_seed',
          description: 'Send one user message to an existing Session and start its first turn, for example to give a freshly created empty Session an opening instruction so it appears in the sidebar.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['session_id', 'text'],
            properties: {
              session_id: { type: 'string', description: 'Target Session id.' },
              text: { type: 'string', description: 'The user message to send.' },
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['sessionId', 'seeded'],
              properties: {
                sessionId: { type: 'string' },
                seeded: { type: 'boolean' },
              },
            },
            render: (_args, value) => [{ type: 'text', text: `Started turn 1 for session ${value.sessionId}.` }],
          },
          execute: (args) => seedSession({ sessionId: args.session_id, text: args.text }),
        }),
        ctx.tools.register({
          name: 'rename_session',
          description: 'Rename a Session and pin its title. The accepted title is stored as an explicit user title, so automatic title generation no longer replaces it. Pass a Session id, or omit it to rename the calling agent session.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['title'],
            properties: {
              title: { type: 'string', description: 'New title text; trimmed, and it must contain visible characters.' },
              session_id: { type: 'string', description: 'Target Session id. Omit to rename the calling agent session.' },
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['sessionId', 'title', 'eventSeq'],
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
                eventSeq: { type: 'integer' },
              },
            },
            render: (_args, value) => [{ type: 'text', text: `Renamed ${value.sessionId} to "${value.title}".` }],
          },
          execute: (args, exec) => renameSession({
            sessionId: args.session_id ?? exec?.agent?.session?.id,
            title: args.title,
          }),
        }),
        ctx.tools.register({
          name: 'session_stop',
          description: 'Stop the turn a Session is currently running — the same path as the sidebar Stop button: the active turn is aborted while queued input is kept. Only ordinary Sessions qualify: the Host rejects a subagent-owned Session (returned as status:error). Returns a structured result with stopped:false (status offline/idle/error) instead of throwing when there is nothing to stop, so a caller can tell "nothing running" from a real failure. Pass a Session id, or omit it to stop the calling agent session (stopping the calling Session aborts its own turn, so this result may never reach the model).',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              session_id: { type: 'string', description: 'Target Session id. Omit to stop the calling agent session.' },
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['sessionId', 'stopped', 'status', 'message'],
              properties: {
                sessionId: { type: 'string' },
                stopped: { type: 'boolean' },
                status: { type: 'string' },
                message: { type: 'string' },
              },
            },
            render: (_args, value) => [{ type: 'text', text: value.message }],
          },
          execute: (args, exec) => stopSession({ sessionId: args.session_id ?? exec?.agent?.session?.id }),
        }),
        ctx.tools.register({
          name: 'session_archive',
          description: 'Archive a Session: it leaves every sidebar list and the pinned area, and its pin is dropped in the same durable write. Archived Sessions can be restored with session_unarchive (or the sidebar "All conversations" → archived view). A running Session is refused by default so its work is not killed silently; pass stop_activity:true to stop it and archive in one step — that stops the running turn, drops queued input, and stops owned jobs/schedules/subagent work. Pass session_id, session_ids for a batch, or omit it to archive the calling agent session.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              session_id: { type: 'string', description: 'Target Session id. Omit to archive the calling agent session.' },
              session_ids: { type: 'array', items: { type: 'string' }, description: 'Batch: archive several Sessions in one call; each id is reported separately.' },
              stop_activity: { type: 'boolean', description: 'Stop the running turn before archiving. Defaults to false, which refuses a running Session with an actionable error.' },
            },
          },
          output: {
            schema: batchOutputSchema(),
            render: batchRender(
              (value) => value.already
                ? `Session ${value.sessionId} is already archived.`
                : `Archived session ${value.sessionId}${value.wasPinned ? ' (unpinned)' : ''}${value.statusCleared ? ', cleared MYCAT status' : ''}.`,
              (item) => item.already ? '已归档（无需重复）' : `已归档${item.wasPinned ? '、取消置顶' : ''}`,
            ),
          },
          execute: async (args, exec) => {
            const targets = resolveTargets(args, exec, { allowDefault: true })
            const operation = (sessionId) => archiveSession({ sessionId, stopActivity: args.stop_activity === true })
            if (targets.batch) return runBatch(targets.ids, operation)
            return { ok: true, ...await operation(targets.ids[0]) }
          },
        }),
        ctx.tools.register({
          name: 'session_unarchive',
          description: 'Unarchive a Session: it leaves the global archive set and returns to its recorded position in the sidebar (and to its workspace group). Idempotent: unarchiving a Session that is not archived returns unarchived:false, wasArchived:false. Pass session_id, or omit it to unarchive the calling agent session.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              session_id: { type: 'string', description: 'Target Session id. Omit to unarchive the calling agent session.' },
            },
          },
          output: {
            schema: batchOutputSchema(),
            render: batchRender(
              (value) => value.wasArchived
                ? `Unarchived session ${value.sessionId}.`
                : `Session ${value.sessionId} was not archived; nothing to do.`,
              (item) => item.wasArchived ? '已取消归档' : '本来就没有归档',
            ),
          },
          execute: async (args, exec) => ({ ok: true, ...await unarchiveSessionTool({ sessionId: args.session_id ?? exec?.agent?.session?.id }) }),
        }),
        ctx.tools.register({
          name: 'session_delete',
          description: 'Delete a Session for real: its stored log directory is moved into a recoverable trash folder ($DSH_HOME/mycat/deleted-sessions) instead of being unlinked; the Session is detached from its workspace, unpinned/unarchived, its MYCAT status cleared, scheduled tasks targeting it are stopped, and the sidebar is told to drop the row. Use session_restore to undo. Because DSH offers no public delete API, only Sessions not attached to the current Host can be removed immediately; a live Session (opened during this DSH run) is stopped, archived (hidden) and queued for automatic deletion at the next DSH startup. Safety: pass dry_run:true to only inspect what would happen, expected_title to verify the target by title, and session_ids for a batch. Refuses to delete the calling Session itself and subagent Sessions.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              session_id: { type: 'string', description: 'Exact id of the Session to delete (required unless session_ids is given; this tool never defaults to the calling Session).' },
              session_ids: { type: 'array', items: { type: 'string' }, description: 'Batch: delete several Sessions in one call; each id is reported separately.' },
              dry_run: { type: 'boolean', description: 'Only report what would be deleted (title, live/cold, location); nothing is modified. Single Session only.' },
              expected_title: { type: 'string', description: 'Verify the target Session title before deleting; mismatch aborts. Single Session only.' },
            },
          },
          output: {
            schema: batchOutputSchema(),
            render: batchRender(
              (value) => value.dryRun === true
                ? `[dry run] ${value.sessionId}${value.live ? ' (live)' : ''}${value.title ? ` "${value.title}"` : ''}: ${value.reason}`
                : value.deleted === true
                  ? `Deleted session ${value.sessionId}; log directory moved to ${value.trashedTo} (recoverable).${Array.isArray(value.workspaces) && value.workspaces.length > 0 ? ` Detached from workspace(s): ${value.workspaces.join(', ')}.` : ''}${value.schedulesStopped > 0 ? ` Stopped ${value.schedulesStopped} scheduled task(s).` : ''}${Array.isArray(value.warnings) && value.warnings.length > 0 ? ` Warnings: ${value.warnings.join('; ')}` : ''}`
                  : `Session ${value.sessionId} was not deleted yet: ${value.reason}`,
              (item) => item.deleted === true
                ? `已删除（回收站 ${item.trashedTo}${item.schedulesStopped > 0 ? `，取消 ${item.schedulesStopped} 个定时任务` : ''}）`
                : item.queued === true ? '仍在运行：已归档隐藏，下次启动时删文件'
                : item.dryRun === true ? `[预演] ${item.reason ?? ''}`
                : (item.reason ?? '完成'),
            ),
          },
          execute: async (args, exec) => {
            const targets = resolveTargets(args, exec, { allowDefault: false })
            const options = {
              callerId: exec?.agent?.session?.id,
              dryRun: args.dry_run === true,
              expectedTitle: args.expected_title,
            }
            if (targets.batch) {
              if (options.dryRun || String(options.expectedTitle ?? '').trim() !== '') throw new Error('dry_run / expected_title 只支持单会话（session_id）')
              return runBatch(targets.ids, (sessionId) => deleteSession({ ...options, sessionId }))
            }
            return { ok: true, ...await deleteSession({ ...options, sessionId: targets.ids[0] }) }
          },
        }),
        ctx.tools.register({
          name: 'session_restore',
          description: 'Restore a Session from MYCAT\'s deletion trash: moves its log directory back to the original path recorded in meta.json, restores the projection cache, re-attaches it to its workspace when possible, and restores the pin/archive state captured at delete time. The restored Session appears in the sidebar after the next client refresh or DSH restart. Pass the exact Session id.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['session_id'],
            properties: {
              session_id: { type: 'string', description: 'Exact id of the trashed Session to restore.' },
            },
          },
          output: {
            schema: batchOutputSchema(),
            render: batchRender(
              (value) => `Restored session ${value.sessionId} to ${value.sourceDir}${value.workspaceRestored ? ' (workspace re-attached)' : ''}${value.pinnedRestored ? ' (pinned)' : ''}${value.archivedRestored ? ' (archived)' : ''}${Array.isArray(value.warnings) && value.warnings.length > 0 ? ` Warnings: ${value.warnings.join('; ')}` : ''}.`,
              (item) => `已恢复${item.workspaceRestored ? '、重新归组' : ''}${item.pinnedRestored ? '、恢复置顶' : ''}${item.archivedRestored ? '、恢复归档' : ''}`,
            ),
          },
          execute: (args) => restoreSession({ sessionId: args.session_id }),
        }),
        ctx.tools.register({
          name: 'session_pin',
          description: 'Pin a Session to the top of the sidebar: the most recently pinned Session comes first, and a pinned Session leaves its workspace group for the pinned area. It starts in MYCAT state "未进行" (todo). Idempotent: pinning an already pinned Session returns already:true and does not reorder. Only a Session that exists live or in persistence can be pinned; pass unarchive:true to lift an archived Session first. Pass session_id, session_ids for a batch, or omit it to pin the calling agent session.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              session_id: { type: 'string', description: 'Target Session id. Omit to pin the calling agent session.' },
              session_ids: { type: 'array', items: { type: 'string' }, description: 'Batch: pin several Sessions in one call.' },
              unarchive: { type: 'boolean', description: 'Unarchive the Session first when it is archived. Defaults to false, which reports an actionable error.' },
            },
          },
          output: {
            schema: batchOutputSchema(),
            render: batchRender(
              (value) => `Pinned session ${value.sessionId}${value.already ? ' (already pinned)' : ''}.`,
              (item) => item.already ? '本来就在置顶区' : '已置顶',
            ),
          },
          execute: async (args, exec) => {
            const targets = resolveTargets(args, exec, { allowDefault: true })
            const operation = (sessionId) => pinSessionTool({ sessionId, allowUnarchive: args.unarchive === true })
            if (targets.batch) return runBatch(targets.ids, operation)
            return { ok: true, ...await operation(targets.ids[0]) }
          },
        }),
        ctx.tools.register({
          name: 'session_unpin',
          description: 'Unpin a Session: it leaves the pinned area and returns to its workspace group in the sidebar. Idempotent: unpinning an already unpinned Session returns already:true. Pass session_id, session_ids for a batch, or omit it to unpin the calling agent session.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              session_id: { type: 'string', description: 'Target Session id. Omit to unpin the calling agent session.' },
              session_ids: { type: 'array', items: { type: 'string' }, description: 'Batch: unpin several Sessions in one call.' },
            },
          },
          output: {
            schema: batchOutputSchema(),
            render: batchRender(
              (value) => `Unpinned session ${value.sessionId}${value.already ? ' (was not pinned)' : ''}.`,
              (item) => item.already ? '本来就没置顶' : '已取消置顶',
            ),
          },
          execute: async (args, exec) => {
            const targets = resolveTargets(args, exec, { allowDefault: true })
            const operation = (sessionId) => unpinSessionTool({ sessionId })
            if (targets.batch) return runBatch(targets.ids, operation)
            return { ok: true, ...await operation(targets.ids[0]) }
          },
        }),
        ctx.tools.register({
          name: 'session_find',
          description: 'Find Sessions by title text, workspace, pinned/archived state, or id fragment, and return their ids. Use it before pinning, archiving or deleting a Session the user names by title. Titles are read from the session log / projection cache, so cold Sessions also match. Returns at most `limit` rows (default 20).',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', description: 'Case-insensitive text matched against the Session title, workspace title, and Session id fragment.' },
              workspace: { type: 'string', description: 'Workspace title or id (or cwd fragment) to filter by.' },
              pinned: { type: 'boolean', description: 'Only pinned (true) or only unpinned (false) Sessions.' },
              archived: { type: 'boolean', description: 'Only archived (true) or only unarchived (false) Sessions.' },
              limit: { type: 'integer', description: 'Maximum rows to return (1-100, default 20).' },
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['ok', 'sessions'],
              properties: {
                ok: { type: 'boolean' },
                total: { type: 'integer' },
                limit: { type: 'integer' },
                truncated: { type: 'boolean' },
                sessions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['sessionId'],
                    properties: {
                      sessionId: { type: 'string' },
                      title: { type: 'string' },
                      workspaceId: { type: 'string' },
                      workspace: { type: 'string' },
                      live: { type: 'boolean' },
                      pinned: { type: 'boolean' },
                      archived: { type: 'boolean' },
                    },
                  },
                },
              },
            },
            render: (_args, value) => [{
              type: 'text',
              text: value.sessions.length === 0
                ? 'No matching sessions.'
                : [`Found ${value.sessions.length} session(s)${value.truncated ? ' (truncated)' : ''}:`, ...value.sessions.map((item) => `- ${item.sessionId}${item.title ? ` "${item.title}"` : ''}${item.workspace ? ` [${item.workspace}]` : ''}${item.live ? ' (live)' : ''}${item.pinned ? ' pinned' : ''}${item.archived ? ' archived' : ''}`)].join('\n'),
            }],
          },
          execute: (args) => findSessions(args),
        }),
      ]
      return () => { for (const dispose of disposers) { try { dispose() } catch {} } }
    })
  } else {
    console.warn('[mycat] tools 服务不可用，会话工具未注册')
  }

  async function reorder(reason) {
    if (disposed) return 0
    const list = registry.list()
    if (list.length < 2) return 0
    const desired = sortedByTitle(list, options.leading).map((workspace) => String(workspace.id))
    let order = list.map((workspace) => String(workspace.id))
    let moves = 0
    for (let index = 0; index < desired.length; index += 1) {
      if (disposed) break
      if (order[index] === desired[index]) continue
      order = (await registry.insertBefore(desired[index], order[index])).map(String)
      moves += 1
    }
    if (moves > 0) console.log(`[mycat] 工作区已按数字前缀重排（${reason}，移动 ${moves} 个）`)
    return moves
  }

  function schedule(reason) {
    if (disposed || !options.enabled) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      chain = chain.then(() => reorder(reason)).catch((error) => {
        console.warn('[mycat] 重排失败：', error?.message ?? error)
      })
    }, options.debounceMs)
  }

  // 注意：cordis 的 ctx.on 默认按 scope 过滤，storage-domain 发出的事件不一定送到本插件；
  // 显式 { global: true } 才能稳定收到（该选项由 cordis EventsService.dispatch 的 filter 逻辑支持）。
  ctx.effect(() => ctx.on('domain/changed', (change) => {
    if (disposed || change?.domain !== DOMAIN) return
    diag.domainChanges += 1
    diag.lastDomainChangeAt = Date.now()
    if (change?.table === '') { if (pruneSessions()) persistSessions(); return }
    if (change?.table !== TABLE) return
    const key = String(change.key ?? '')
    if (change.operation === 'deleted') { titles.delete(key); return }
    const workspace = registry.list().find((candidate) => String(candidate.id) === key)
    if (workspace === undefined) return
    const previous = titles.get(key)
    titles.set(key, workspace.title)
    if (previous === undefined) schedule('新建工作区')
    else if (previous !== workspace.title) schedule('工作区改名')
  }, { global: true }))

  ctx.effect(() => () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
  })

  /* ------------------------------------------------------------ 会话状态 */

  let sessions = loadSessions()
  let ui = loadUi()
  // 运行时偏好：bundle config 提供默认值，$DSH_HOME/mycat/prefs.json 覆盖。
  let prefs = loadPrefs()
  let prefsMtime = (() => { try { return fs.statSync(PREFS_FILE).mtimeMs } catch { return 0 } })()
  let lastRestored = null
  const diag = { domainChanges: 0, lastDomainChangeAt: null, prefsReloads: 0 }
  const lastRunning = new Map()

  const refreshPrefs = () => {
    try {
      const mtime = fs.statSync(PREFS_FILE).mtimeMs
      if (mtime === prefsMtime) return
      prefsMtime = mtime
      prefs = loadPrefs()
      diag.prefsReloads += 1
    } catch (error) {
      if (prefsMtime !== 0) { prefsMtime = 0; prefs = {} }
    }
  }
  const reviewEnabled = () => (prefs.requireReview === undefined ? options.requireReview : prefs.requireReview === true)
  const trashLimits = () => ({
    keepDays: prefs.trashKeepDays === undefined ? options.trashKeepDays : prefs.trashKeepDays,
    maxBytes: (prefs.trashMaxMB === undefined ? options.trashMaxMB : prefs.trashMaxMB) * 1024 * 1024,
  })

  const pinnedIds = () => {
    try { return new Set((registry.pinnedSessionIds ?? []).map(String)) } catch { return undefined }
  }

  const archivedIds = () => {
    try { return new Set((registry.archivedSessionIds ?? []).map(String)) } catch { return new Set() }
  }

  function persistSessions() {
    try { saveSessions(sessions) } catch (error) { console.warn('[mycat] 会话状态保存失败：', error?.message ?? error) }
  }

  /** 只保留仍然置顶的会话：取消置顶即回到工作区，重新置顶从「未进行」开始。 */
  function pruneSessions() {
    const pinned = pinnedIds()
    if (pinned === undefined) return false
    let changed = false
    for (const id of Object.keys(sessions)) {
      if (!pinned.has(id)) { delete sessions[id]; changed = true }
    }
    return changed
  }

  function autoSet(id, status) {
    const current = sessions[id]
    if (current?.status === 'blocked' || current?.status === status) return
    sessions = { ...sessions, [id]: { status, auto: true, updatedAt: new Date().toISOString() } }
    persistSessions()
  }

  /** 停止后把「进行中」改成「等我处理」：被中止的那一轮不会再自己走到 wait（列表是人工停止的）。 */
  function markStopped(id) {
    lastRunning.set(id, false)
    const entry = sessions[id]
    if (entry === undefined || entry.status !== 'doing') return false
    sessions = { ...sessions, [id]: { status: 'wait', auto: true, updatedAt: new Date().toISOString() } }
    persistSessions()
    return true
  }

  /** 归档后清掉 MYCAT 自己的置顶状态：以后重新置顶从「未进行」开始，状态机不留脏数据。 */
  function forgetSession(id) {
    lastRunning.delete(id)
    if (sessions[id] === undefined) return false
    const next = { ...sessions }
    delete next[id]
    sessions = next
    persistSessions()
    return true
  }

  // 定时兜底：置顶集合在插件外部（官方 UI / 其它进程）变化时，保证 session-status.json 不留脏条目。
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (disposed) return
      try { if (pruneSessions()) persistSessions() } catch (error) { console.warn('[mycat] 会话状态定时剪枝失败：', error?.message ?? error) }
    }, 60_000)
    return () => clearInterval(timer)
  })

  ctx.effect(() => ctx.on('agent/status', (event) => {
    const id = String(event?.agent?.id ?? '')
    if (disposed || id === '') return
    const running = event?.status === 'running'
    const previous = lastRunning.get(id)
    lastRunning.set(id, running)
    if (!pinnedIds()?.has(id)) return
    if (running && previous !== true) autoSet(id, 'doing')
    else if (!running && previous === true) autoSet(id, 'wait')
  }))

  /** 启动时：上次自动标成「进行中」、现在已不在运行的置顶会话，补成「等我处理」。 */
  function reconcileSessions() {
    let changed = pruneSessions()
    const agents = ctx.get('agents')
    for (const [id, entry] of Object.entries(sessions)) {
      if (entry?.status !== 'doing' || entry.auto !== true) continue
      if (agents?.get?.(id)?.status === 'running') continue
      sessions = { ...sessions, [id]: { status: 'wait', auto: true, updatedAt: new Date().toISOString() } }
      changed = true
    }
    if (changed) persistSessions()
  }

  /* ------------------------------------------------------------ 接口 */

  const json = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  const readBody = async (request) => {
    try { return await request.json() } catch { return {} }
  }
  const prefsView = () => ({
    requireReview: reviewEnabled(),
    notifyWait: prefs.notifyWait === undefined ? options.notifyWait : prefs.notifyWait === true,
    trashKeepDays: prefs.trashKeepDays === undefined ? options.trashKeepDays : prefs.trashKeepDays,
    trashMaxMB: prefs.trashMaxMB === undefined ? options.trashMaxMB : prefs.trashMaxMB,
  })
  const stateBody = () => {
    refreshPrefs()
    // 兜底：官方 UI 改置顶集合时不一定稳定触发 domain/changed，读取状态时顺手剪掉非置顶的脏条目。
    try { if (pruneSessions()) persistSessions() } catch (error) { console.warn('[mycat] 会话状态剪枝失败：', error?.message ?? error) }
    return {
      ok: true,
      version: PLUGIN_VERSION,
      sessions,
      ui,
      prefs: prefsView(),
      restored: lastRestored,
      diag: { domainChanges: diag.domainChanges, lastDomainChangeAt: diag.lastDomainChangeAt, prefsReloads: diag.prefsReloads },
      trash: trashSummary(),
      pendingDeletes: Object.keys(loadPendingDeletes()).length,
    }
  }

  ctx.inject(['connection'], (scope) => {
    const route = (pathname, methods, fetch) => scope.connection.fetch.register({ path: pathname, methods, requestBody: 'buffered', fetch })
    route('/api/mycat/state', ['GET'], async () => json(200, stateBody()))
    // 会话管理面板：列表 + 批量动作（pin/unpin/archive/unarchive/delete/restore）
    route('/api/mycat/sessions', ['GET'], async () => json(200, { ok: true, sessions: await sessionsOverview() }))
    route('/api/mycat/sessions/action', ['POST'], async (request) => {
      const body = await readBody(request)
      const action = String(body.action ?? '')
      const allowed = ['pin', 'unpin', 'archive', 'unarchive', 'delete', 'restore']
      if (!allowed.includes(action)) return json(400, { ok: false, error: `未知动作：${action}` })
      const ids = Array.isArray(body.sessionIds)
        ? [...new Set(body.sessionIds.map((value) => String(value ?? '').trim()).filter(Boolean))]
        : []
      if (ids.length === 0) return json(400, { ok: false, error: '缺少 sessionIds' })
      if (ids.length > 200) return json(400, { ok: false, error: '一次最多处理 200 个会话' })
      const stopActivity = body.stopActivity === true
      const results = []
      for (const sessionId of ids) {
        try {
          let result
          if (action === 'pin') result = await pinSessionTool({ sessionId })
          else if (action === 'unpin') result = await unpinSessionTool({ sessionId })
          else if (action === 'archive') result = await archiveSession({ sessionId, stopActivity })
          else if (action === 'unarchive') result = await unarchiveSessionTool({ sessionId })
          else if (action === 'delete') result = await deleteSession({ sessionId })
          else result = await restoreSession({ sessionId })
          results.push({ ok: true, sessionId, ...result })
        } catch (error) {
          results.push({ ok: false, sessionId, error: error?.message ?? String(error) })
        }
      }
      const succeeded = results.filter((item) => item.ok === true).length
      return json(200, { ok: true, results, succeeded, failed: results.length - succeeded })
    })
    route('/api/mycat/stats', ['GET'], async () => json(200, await statsOverview()))
    route('/api/mycat/ui', ['GET', 'POST'], async (request) => {
      if (request.method === 'POST') {
        const body = await readBody(request)
        const theme = String(body.theme ?? '')
        if (!UI_THEMES.includes(theme)) return json(400, { ok: false, error: `未知配色方案：${theme}` })
        ui = { ...ui, theme }
        saveUi(ui)
        return json(200, { ok: true, ui })
      }
      return json(200, { ok: true, ui })
    })
    route('/api/mycat/session-status', ['POST'], async (request) => {
      const body = await readBody(request)
      const id = String(body.sessionId ?? '')
      const status = body.status === null ? null : String(body.status ?? '')
      if (id === '') return json(400, { ok: false, error: '缺少 sessionId' })
      if (status !== null && !SESSION_STATUSES.includes(status)) return json(400, { ok: false, error: `未知会话状态：${status}` })
      if (!pinnedIds()?.has(id)) return json(400, { ok: false, error: '只有置顶会话可以设置状态' })
      const next = { ...sessions }
      if (status === null) delete next[id]
      else next[id] = { status, auto: false, updatedAt: new Date().toISOString() }
      sessions = next
      pruneSessions()
      persistSessions()
      return json(200, { ok: true, sessions })
    })
    // 运行时偏好：设置页读写（覆盖 bundle config 默认值）。
    route('/api/mycat/prefs', ['GET', 'POST'], async (request) => {
      if (request.method === 'POST') {
        const body = await readBody(request)
        const next = { ...prefs }
        if (body.requireReview !== undefined) {
          if (typeof body.requireReview !== 'boolean') return json(400, { ok: false, error: 'requireReview 必须是布尔值' })
          next.requireReview = body.requireReview
        }
        if (body.notifyWait !== undefined) {
          if (typeof body.notifyWait !== 'boolean') return json(400, { ok: false, error: 'notifyWait 必须是布尔值' })
          next.notifyWait = body.notifyWait
        }
        if (body.trashKeepDays !== undefined) {
          const value = Number(body.trashKeepDays)
          if (!Number.isFinite(value) || value < 1 || value > 3650) return json(400, { ok: false, error: 'trashKeepDays 必须是 1-3650 的整数' })
          next.trashKeepDays = Math.round(value)
        }
        if (body.trashMaxMB !== undefined) {
          const value = Number(body.trashMaxMB)
          if (!Number.isFinite(value) || value < 1 || value > 102400) return json(400, { ok: false, error: 'trashMaxMB 必须是 1-102400 的整数' })
          next.trashMaxMB = Math.round(value)
        }
        try {
          savePrefs(next)
          prefs = loadPrefs()
          try { prefsMtime = fs.statSync(PREFS_FILE).mtimeMs } catch { prefsMtime = 0 }
        } catch (error) {
          return json(500, { ok: false, error: `偏好保存失败：${error?.message ?? error}` })
        }
        return json(200, { ok: true, prefs: prefsView() })
      }
      return json(200, { ok: true, prefs: prefsView() })
    })
    // 回收站：设置页展示 + 一键清空。
    route('/api/mycat/trash', ['GET', 'DELETE'], async (request) => {
      if (request.method === 'DELETE') return json(200, { ok: true, removed: clearTrash() })
      return json(200, { ok: true, ...trashSummary() })
    })
    route('/api/mycat/log', ['GET', 'POST'], async (request) => {
      if (request.method === 'POST') {
        const body = await readBody(request)
        const message = String(body.message ?? '').slice(0, 4000)
        if (message !== '') {
          const at = new Date().toISOString()
          clientLogs.push({ at, message })
          if (clientLogs.length > 30) clientLogs.shift()
          try {
            fs.mkdirSync(MYCAT_DIR, { recursive: true })
            fs.appendFileSync(path.join(MYCAT_DIR, 'client-error.log'), `${at} ${message}\n`)
          } catch {}
        }
      }
      return json(200, { ok: true, logs: clientLogs.slice(-20) })
    })
  })

  function start(attempt = 0) {
    if (disposed) return
    try {
      remember(registry.list())
      schedule('启动')
      reconcileSessions()
      try { pruneTrash() } catch (error) { console.warn('[mycat] 启动清理回收站失败：', error?.message ?? error) }
      schedulePendingDeleteFlush()
    } catch (error) {
      if (attempt >= 20) return
      setTimeout(() => start(attempt + 1), 500)
    }
  }

  start()
}
