/**
 * lib/queue.js — 朗读队列的纯逻辑核心。
 *
 * 这一层**不依赖 DSH / cordis / 浏览器**，只处理字符串与数组，所以可以直接用
 * `node --test` 覆盖。宿主插件（lib/index.js）只负责把「一段回复」喂进来，
 * 浏览器扩展只负责把「一条要念的话」取走。
 *
 * 三条纪律（都是踩出来的）：
 *  ① **同一段话只念一次**：靠内容指纹去重，而不是靠"已经念到第几条"的游标。
 *     游标会在扩展重装、页面刷新后错位，指纹不会。
 *  ② **念之前先洗一遍**：代码块、表格、链接、markdown 记号、多余空白全部去掉，
 *     否则会听见「星号星号星号」和一堆反引号。
 *  ③ **宁短勿长**：超长的整段直接截断并留下省略号；把几万字念出来没人受得了。
 */

/** 默认配置。宿主插件会把用户配置合并到这里。 */
export const DEFAULT_QUEUE_OPTIONS = Object.freeze({
  /** 单条最多念多少个字（超出截断） */
  maxChars: 600,
  /** 队列最多存多少条（超出丢最旧的） */
  maxItems: 40,
  /** 去掉代码块 */
  stripCode: true,
  /** 去掉 markdown 记号 */
  stripMarkdown: true,
  /** 丢掉纯链接/纯符号的噪音行 */
  dropNoise: true,
})

/** 全角/半角统一用的空白判定 */
const BLANK = /^[\s\u3000]*$/

/**
 * 把一段 markdown 洗成适合朗读的纯文本。
 * 纯函数：同样的输入永远得到同样的输出（去重要靠这个）。
 */
export function toSpeakable(input, options = {}) {
  const opt = { ...DEFAULT_QUEUE_OPTIONS, ...options }
  let text = String(input ?? '')

  if (opt.stripCode) {
    // 围栏代码块整块删掉（朗读代码没有意义）
    text = text.replace(/```[\s\S]*?```/g, '\n')
    // 行内代码：保留内容、去掉反引号
    text = text.replace(/`([^`\n]*)`/g, '$1')
  }

  if (opt.stripMarkdown) {
    // 图片直接丢，链接只留文字
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 标题井号、引用符号、列表符号
    text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
    text = text.replace(/^\s{0,3}>\s?/gm, '')
    text = text.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    // 强调/删除线记号
    text = text.replace(/(\*\*|__)(.*?)\1/g, '$2')
    text = text.replace(/(\*|_)(.*?)\1/g, '$2')
    text = text.replace(/~~(.*?)~~/g, '$1')
    // 分隔线
    text = text.replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, '')
    // 表格的竖线换成停顿
    text = text.replace(/\s*\|\s*/g, '，')
  }

  // 逐行清理
  const lines = text.split(/\r?\n/).map((line) => line.replace(/[ \t\u3000]+/g, ' ').trim())

  const kept = []
  for (const line of lines) {
    if (!line || BLANK.test(line)) continue
    if (opt.dropNoise) {
      // 纯 URL 没有朗读价值
      if (/^https?:\/\/\S+$/i.test(line)) continue
      // 不含任何字母/数字/汉字的行（纯符号）丢掉。
      // ⚠ 必须用 Unicode 属性类：JS 的 \W 不把中文当单词字符，
      //   早期写成 [\W_]+ 会把「你好呀」这类短中文句子整句误杀。
      if (/^[^\p{L}\p{N}]*$/u.test(line)) continue
    }
    kept.push(line)
  }

  let out = kept.join('\n').trim()

  if (out && out.length > opt.maxChars) {
    // 尽量在标点处断开，别把词切成两半
    const head = out.slice(0, opt.maxChars)
    const cut = Math.max(
      head.lastIndexOf('。'),
      head.lastIndexOf('！'),
      head.lastIndexOf('？'),
      head.lastIndexOf('\n'),
      head.lastIndexOf('，'),
    )
    out = (cut > opt.maxChars * 0.6 ? head.slice(0, cut + 1) : head).trim() + '……'
  }

  return out
}

/** 一小段稳定指纹（djb2 变体），用来判重；不需要密码学强度。 */
export function fingerprint(text) {
  let h = 5381
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h.toString(36) + '-' + s.length.toString(36)
}

/**
 * 朗读队列。纯内存 + 可注入时钟，方便测试。
 *
 * 条目形状：
 *   { id, text, sessionId, sessionTitle, createdAt, spokenAt|null }
 */
export class SpeakQueue {
  #items = []
  #seen = new Set()
  #maxItems
  #maxChars
  #now
  #seq = 0

  constructor(options = {}) {
    const opt = { ...DEFAULT_QUEUE_OPTIONS, ...options }
    this.#maxItems = Math.max(1, Number(opt.maxItems) || DEFAULT_QUEUE_OPTIONS.maxItems)
    this.#maxChars = Math.max(40, Number(opt.maxChars) || DEFAULT_QUEUE_OPTIONS.maxChars)
    this.#now = typeof opt.now === 'function' ? opt.now : () => Date.now()
    this.options = opt
  }

  get size() {
    return this.#items.length
  }

  /** 队列里还没被取走的条数 */
  get pendingCount() {
    let n = 0
    for (const it of this.#items) if (it.spokenAt == null) n += 1
    return n
  }

  /**
   * 投入一段回复。返回入队条目；被去重/洗空时返回 null。
   * 不会抛错——朗读是锦上添花，绝不该让会话失败。
   */
  push(rawText, meta = {}) {
    const text = toSpeakable(rawText, { ...this.options, maxChars: this.#maxChars })
    if (!text) return null

    const id = fingerprint(text)
    if (this.#seen.has(id)) return null
    this.#seen.add(id)

    const item = {
      id,
      text,
      sessionId: meta.sessionId == null ? null : String(meta.sessionId),
      sessionTitle: meta.sessionTitle == null ? null : String(meta.sessionTitle),
      createdAt: this.#now(),
      spokenAt: null,
      seq: (this.#seq += 1),
    }
    this.#items.push(item)

    // 超量丢最旧的（同时把它的指纹从 seen 里去掉是错的：会允许它再次入队造成循环）
    while (this.#items.length > this.#maxItems) this.#items.shift()

    return item
  }

  /** 取走一条待念的（标记已取），没有就返回 null */
  take() {
    for (const it of this.#items) {
      if (it.spokenAt == null) {
        it.spokenAt = this.#now()
        return { ...it }
      }
    }
    return null
  }

  /** 按 id 取（不改变状态） */
  peek(id) {
    const it = this.#items.find((x) => x.id === String(id))
    return it ? { ...it } : null
  }

  /** 列出条目。scope = 'pending' | 'all' */
  list(scope = 'pending') {
    const arr = scope === 'all' ? this.#items : this.#items.filter((x) => x.spokenAt == null)
    return arr.map((x) => ({ ...x }))
  }

  /** 把一条标记为已念（扩展念完回调） */
  markSpoken(id) {
    const it = this.#items.find((x) => x.id === String(id))
    if (!it) return false
    if (it.spokenAt == null) it.spokenAt = this.#now()
    return true
  }

  /** 清空队列（保留去重指纹，避免把同一批话又念一遍） */
  clear() {
    this.#items = []
    return true
  }

  /** 彻底重置（含去重指纹），测试用 */
  reset() {
    this.#items = []
    this.#seen.clear()
    this.#seq = 0
  }
}
