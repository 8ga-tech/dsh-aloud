/**
 * dsh-aloud — 朗读桥（宿主半边）
 *
 * 它只做一件事：把「她刚说的话」排进一个本地队列，并开几个回环 HTTP 接口让
 * 浏览器扩展来取。真正的发声在浏览器里（SpeechSynthesis，或你自己点的朗读按钮），
 * 所以这个插件**不产生任何语音流量、不调用任何语音 API、不花钱**。
 *
 * 两个来源（可各自开关）：
 *   ① 会话日志监听：轮询 $DSH_HOME/sessions 下的 *.jsonl(.zstd)，把新的助手文本入队。
 *   ② 外部投喂：POST <prefix>/say 直接把一段文字塞进队列（脚本、其它插件都行）。
 *
 * 取用接口（给扩展）：
 *   GET  <prefix>/next   取一条待念的（取走后标记为已取）
 *   POST <prefix>/ack    念完了回执 { id }
 *   GET  <prefix>/list   看看队列里有什么
 *   POST <prefix>/say    手动投喂 { text }
 *   GET  <prefix>/health 探活
 *
 * 纪律：朗读是锦上添花。任何一处出错都只记 warn，绝不 throw 到宿主。
 */
import z from '@deepseek-ai/schemastery'
import os from 'node:os'
import path from 'node:path'
import { SpeakQueue } from './queue.js'
import { SessionWatcher, contentToText } from './watch.js'

/** Cordis 插件名（也是设置页的命名空间） */
export const name = 'aloud'

/** 不强制依赖任何服务：拿不到 webServer 就只填队列、不开接口 */
export const inject = []

/** 配置：全部有默认值，`cordis.patch.yml` 里可以整块省略 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  /** HTTP 路由前缀 */
  prefix: z.string().default('/dsh-aloud'),
  /** 单条最多念多少字 */
  maxChars: z.number().default(600),
  /** 队列上限 */
  maxItems: z.number().default(40),
  /** 是否额外用会话日志轮询兜底（默认关：session/event 已经够用） */
  watchLogs: z.boolean().default(false),
  /** 会话目录（默认 $DSH_HOME/sessions） */
  sessionsDir: z.string().default(''),
  /** 轮询间隔（毫秒） */
  pollMs: z.number().default(3000),
})

/** 解析 DSH 主目录 */
function resolveDshHome() {
  const env = process.env.DSH_HOME
  if (env && env.trim()) return env.trim()
  return path.join(os.homedir(), '.dsh')
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    // 扩展是从 chrome-extension:// 发起的，需要跨源；接口只监听回环
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  })
  res.end(body)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let data = ''
    let over = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (over) return
      data += chunk
      if (data.length > limit) {
        over = true
        resolve('')
      }
    })
    req.on('end', () => resolve(over ? '' : data))
    req.on('error', () => resolve(''))
  })
}

function parseJson(text) {
  if (!text) return null
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/**
 * Cordis 挂载点。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
  const cfg = {
    enabled: true,
    prefix: '/dsh-aloud',
    maxChars: 600,
    maxItems: 40,
    watchLogs: false,
    sessionsDir: '',
    pollMs: 3000,
    ...config,
  }
  const logger = ctx.logger ?? console

  if (cfg.enabled === false) {
    logger.info?.('aloud: 已禁用（enabled=false），不启动')
    return
  }

  const prefix = String(cfg.prefix || '/dsh-aloud').replace(/\/+$/, '') || '/dsh-aloud'
  const queue = new SpeakQueue({
    maxChars: Number(cfg.maxChars) || 600,
    maxItems: Number(cfg.maxItems) || 40,
  })

  // ── ① 首选来源：session/event（官方写法，turn/end 即一轮结束）─────
  //   turn/end 本身不带文本，必须在 assistant/message 时自己攒。
  const partial = new Map() // sessionId -> 本轮最后一条助手文本
  try {
    ctx.on('session/event', (session, event) => {
      try {
        const sid = session?.id != null ? String(session.id) : 'unknown'
        const type = event?.type
        if (typeof type !== 'string') return
        if (type === 'assistant/message') {
          const content = event?.data?.message?.content ?? event?.data?.content
          const text = contentToText(content)
          if (text && text.trim()) partial.set(sid, text)
          return
        }
        if (type === 'turn/end') {
          const text = partial.get(sid)
          partial.delete(sid)
          if (!text) return
          const item = queue.push(text, { sessionId: sid })
          if (item) logger.debug?.(`aloud: 入队 ${item.text.length} 字（${item.id}）`)
        }
      } catch (e) {
        logger.warn?.(`aloud: 处理会话事件失败: ${e?.message ?? e}`)
      }
    })
    logger.info?.('aloud: 已订阅 session/event（每轮结束自动入队）')
  } catch (e) {
    logger.warn?.(`aloud: 订阅 session/event 失败: ${e?.message ?? e}`)
  }

  // ── ② 兜底来源：会话日志轮询（某些组合没有会话事件时用）──────────
  let watcher = null
  if (cfg.watchLogs === true) {
    const root = cfg.sessionsDir && String(cfg.sessionsDir).trim()
      ? String(cfg.sessionsDir).trim()
      : path.join(resolveDshHome(), 'sessions')
    try {
      watcher = new SessionWatcher({
        root,
        intervalMs: Number(cfg.pollMs) || 3000,
        logger,
        onText: (text, file) => {
          const item = queue.push(text, { sessionId: path.basename(path.dirname(file)) })
          if (item) logger.debug?.(`aloud: 入队 ${item.text.length} 字（${item.id}）`)
        },
      })
      watcher.start()
      ctx.effect(() => () => watcher?.stop(), 'aloud.watch()')
      logger.info?.(`aloud: 正在监听会话日志 ${root}`)
    } catch (e) {
      logger.warn?.(`aloud: 会话日志监听启动失败（继续以手动投喂方式工作）: ${e?.message ?? e}`)
      watcher = null
    }
  }

  // ── ③ HTTP 接口（给浏览器扩展）─────────────────────────────
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.slice(prefix.length) || '/'

      if (req.method === 'OPTIONS') return sendJson(res, 204, {})

      if (route === '/health' || route === '/' ) {
        return sendJson(res, 200, {
          ok: true,
          plugin: 'dsh-aloud',
          pending: queue.pendingCount,
          size: queue.size,
          watching: watcher != null,
        })
      }

      if (route === '/next' && req.method === 'GET') {
        const item = queue.take()
        return sendJson(res, 200, { ok: true, item, pending: queue.pendingCount })
      }

      if (route === '/list' && req.method === 'GET') {
        const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'pending'
        return sendJson(res, 200, { ok: true, items: queue.list(scope) })
      }

      if (route === '/ack' && req.method === 'POST') {
        const body = parseJson(await readBody(req))
        const id = body?.id
        if (!id) return sendJson(res, 400, { ok: false, error: 'id_required' })
        return sendJson(res, 200, { ok: queue.markSpoken(String(id)) })
      }

      if (route === '/say' && req.method === 'POST') {
        const body = parseJson(await readBody(req))
        const text = body?.text
        if (!text) return sendJson(res, 400, { ok: false, error: 'text_required' })
        const item = queue.push(text, { sessionId: body?.sessionId ?? null, sessionTitle: body?.sessionTitle ?? null })
        return sendJson(res, 200, { ok: true, queued: item != null, item, pending: queue.pendingCount })
      }

      if (route === '/clear' && req.method === 'POST') {
        queue.clear()
        return sendJson(res, 200, { ok: true })
      }

      return sendJson(res, 404, { ok: false, error: 'not_found', route })
    } catch (e) {
      logger.warn?.(`aloud: 请求处理失败: ${e?.message ?? e}`)
      try {
        sendJson(res, 500, { ok: false, error: 'internal' })
      } catch { /* 响应已发出 */ }
    }
  }

  // 官方推荐的注册姿势：ctx.inject(['webServer'], ...) 里再 effect，
  // 这样没装 webServer 的组合不会让插件加载失败（只是没有 HTTP 面）。
  const register = (webCtx) => {
    try {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'prefix', path: prefix, handler }),
        'aloud.route()',
      )
      logger.info?.(`aloud: HTTP 接口已挂在 ${prefix}（GET ${prefix}/next 取一条）`)
    } catch (e) {
      logger.warn?.(`aloud: 注册 HTTP 路由失败: ${e?.message ?? e}`)
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], register)
  } else {
    try {
      if (ctx.webServer && typeof ctx.webServer.register === 'function') register(ctx)
      else logger.warn?.('aloud: 没有可用的 webServer 服务，HTTP 接口未开启（只会填队列）')
    } catch (e) {
      logger.warn?.(`aloud: 注册 HTTP 路由失败: ${e?.message ?? e}`)
    }
  }
}
