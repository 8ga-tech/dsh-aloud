/**
 * lib/watch.js — 从 DSH 的会话日志里取出「助手说了什么」。
 *
 * 为什么走日志而不是内部事件总线：agent 的事件挂在每个 agent 自己的 loop 上下文上，
 * 第三方插件能否直接订阅没有保证；而会话日志是**落盘的既定事实**，且格式稳定。
 * 这里只做两件事：反序列化一行行记录 + 把其中的助手文本块挑出来。
 *
 * 纯函数部分（parseLine / extractAssistantTexts）不碰文件系统，可以直接单测；
 * 文件监听（SessionWatcher）再包在外面。
 */
import fs from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/**
 * 解析一行 JSONL。坏行返回 null（日志里可能有半行/空行）。
 * @returns {object|null}
 */
export function parseLine(line) {
  const s = String(line ?? '').trim()
  if (!s || s[0] !== '{') return null
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/** 从 content 里抽纯文本。content 可能是字符串、段数组、或带 text 的对象。 */
export function contentToText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part == null) return ''
        if (typeof part === 'string') return part
        if (typeof part.text === 'string') return part.text
        if (part.type === 'text' && part.data && typeof part.data.text === 'string') return part.data.text
        return ''
      })
      .join('\n')
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

/** 一条记录是不是「助手的最终回复」——只有这种才值得念。 */
export function isAssistantMessage(record) {
  if (!record) return false
  const role = record.role ?? record.message?.role
  if (role !== 'assistant') return false
  // 跳过流式增量/工具调用片段：只认带完整 content 的消息记录
  if (record.partial === true || record.streaming === true) return false
  const content = record.content ?? record.message?.content
  return contentToText(content).trim().length > 0
}

/**
 * 从一批记录里按顺序抽出助手文本。
 * @param {object[]} records
 * @returns {string[]}
 */
export function extractAssistantTexts(records) {
  const out = []
  for (const rec of Array.isArray(records) ? records : []) {
    if (!isAssistantMessage(rec)) continue
    const text = contentToText(rec.content ?? rec.message?.content).trim()
    if (text) out.push(text)
  }
  return out
}

/** 把一段 zstd 压缩的 JSONL 缓冲解成记录数组。解不开就返回空数组。 */
export function decodeSessionBuffer(buf) {
  let raw = ''
  try {
    raw = zstdDecompressSync(buf).toString('utf8')
  } catch {
    // 不是 zstd（也许已经解压过，或写到一半）
    try {
      raw = Buffer.from(buf).toString('utf8')
    } catch {
      return []
    }
  }
  const records = []
  for (const line of raw.split(/\r?\n/)) {
    const rec = parseLine(line)
    if (rec) records.push(rec)
  }
  return records
}

/**
 * 会话日志监听器：轮询 `sessions` 目录下被改动的 `.zstd` 文件，
 * 每次把新增的助手文本交给 onText。
 *
 * 用 (文件大小 + mtime) 做变更指纹；文件整体重解压（会话文件通常在几百 KB 级），
 * 用「已处理条数」做增量游标。失败一律吞掉并记一条 warn —— 朗读是锦上添花，
 * 绝不该因为它读不懂日志就让宿主报错。
 */
export class SessionWatcher {
  #root
  #onText
  #logger
  #intervalMs
  #state = new Map()
  #timer = null
  #stopped = false

  constructor({ root, onText, logger, intervalMs = 3000 }) {
    this.#root = root
    this.#onText = onText
    this.#logger = logger ?? { warn() {}, debug() {} }
    this.#intervalMs = Math.max(500, Number(intervalMs) || 3000)
  }

  start() {
    if (this.#timer) return
    this.scan()
    this.#timer = setInterval(() => this.scan(), this.#intervalMs)
    // 不要因为这个定时器让进程无法退出
    if (typeof this.#timer.unref === 'function') this.#timer.unref()
  }

  stop() {
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  /** 找会话日志文件（限定深度，避免把整个 home 扫一遍） */
  #listFiles() {
    const out = []
    const walk = (dir, depth) => {
      if (depth > 3) return
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, depth + 1)
        else if (e.name.endsWith('.jsonl.zstd') || e.name.endsWith('.jsonl')) out.push(full)
      }
    }
    walk(this.#root, 0)
    return out
  }

  scan() {
    if (this.#stopped) return
    for (const file of this.#listFiles()) {
      try {
        const st = fs.statSync(file)
        const prev = this.#state.get(file)
        // 没变化就跳过
        if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue

        const records = decodeSessionBuffer(fs.readFileSync(file))
        const startAt = prev ? prev.count : Math.max(0, records.length - 1) // 首次只从最后一条开始
        const fresh = records.slice(startAt)
        this.#state.set(file, { size: st.size, mtimeMs: st.mtimeMs, count: records.length })

        const texts = extractAssistantTexts(fresh)
        for (const t of texts) {
          try {
            this.#onText(t, file)
          } catch (e) {
            this.#logger.warn?.(`aloud: onText failed: ${e?.message ?? e}`)
          }
        }
      } catch (e) {
        this.#logger.debug?.(`aloud: skip ${path.basename(file)}: ${e?.message ?? e}`)
      }
    }
  }
}
