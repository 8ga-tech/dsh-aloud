/**
 * 扩展侧实机测试台（需要在跑着的 DSH 上执行）。
 *
 * 用一套仿造的 `chrome.*` API 把 `extension/background.js` 真跑起来，验证：
 *   ① 后台能取到宿主队列里的条目
 *   ② 调用了 chrome.tts.speak，且念的是**洗过 markdown 之后**的文本
 *   ③ 念完会 POST /ack 回执（宿主那边该条被标记为已念，队列清空）
 *   ④ 宿主不可达时不抛错，只记 lastError
 *
 * 唯一测不到的是「真的有声音出来」——那需要真实浏览器的扬声器。
 *
 * 用法（先按 README 把插件装进某个 profile 并启动）：
 *
 *   node tests/extension-harness.mjs http://127.0.0.1:43999
 *
 * 参数：<DSH 地址>，默认 http://127.0.0.1:43120
 */
import { pathToFileURL } from 'node:url'

const BASE = process.argv[2] ?? 'http://127.0.0.1:43120'
const SW = new URL('../extension/background.js', import.meta.url)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ── 仿造 chrome ────────────────────────────────────────────────────────────
const store = {}
const spoken = []
const listeners = { alarm: [], installed: [], startup: [], message: [] }

globalThis.chrome = {
  storage: {
    local: {
      async get(defaults) { return { ...defaults, ...store } },
      async set(patch) { Object.assign(store, patch) },
    },
  },
  alarms: {
    async create() {},
    onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
  },
  runtime: {
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
  },
  tts: {
    speak(text, opts) {
      spoken.push({ text, opts })
      setTimeout(() => opts?.onEvent?.({ type: 'end' }), 10)
    },
    stop() {},
  },
}

// 别让后台的轮询定时器把 Node 挂住
const realSetInterval = globalThis.setInterval
globalThis.setInterval = (fn, ms) => {
  const t = realSetInterval(fn, ms)
  t.unref?.()
  return t
}

store.enabled = true
store.baseUrl = BASE
store.rate = 1
store.volume = 1
store.pollSeconds = 5

// ── 载入扩展后台 ──────────────────────────────────────────────────────────
await import(pathToFileURL(SW.pathname).href)
check('background.js 载入并注册了消息监听', listeners.message.length === 1)

function sendMessage(msg) {
  return new Promise((resolve) => {
    const ret = listeners.message[0](msg, {}, resolve)
    if (ret !== true) resolve(undefined)
  })
}

// ── 场景：宿主在线，队列里有话 ────────────────────────────────────────────
const text = '这是扩展实机测试要念的一句话，**带 markdown**。'
const queued = await fetch(`${BASE}/dsh-aloud/say`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text }),
}).catch(() => null)
if (!queued?.ok) {
  console.error(`\n宿主不可达（${BASE}）。请先启动装了 dsh-aloud 的 DSH 实例。`)
  process.exit(2)
}

const res = await sendMessage({ type: 'poll' })
check('扩展调通了宿主 /next', res?.ok === true, JSON.stringify(res))

await new Promise((r) => setTimeout(r, 300))

check('调用了 chrome.tts.speak', spoken.length >= 1, `调用 ${spoken.length} 次`)
if (spoken.length) {
  const said = spoken[spoken.length - 1].text
  check('念的是洗过 markdown 的文本', said.includes('这是扩展实机测试要念的一句话') && !said.includes('**'), said)
}

const after = await (await fetch(`${BASE}/dsh-aloud/health`)).json()
check('回执后宿主队列已清空', after.pending === 0, JSON.stringify(after))

// ── 场景：宿主不可达 ──────────────────────────────────────────────────────
await chrome.storage.local.set({ baseUrl: 'http://127.0.0.1:1' })
const bad = await sendMessage({ type: 'poll' })
const state = await sendMessage({ type: 'getState' })
check('宿主不可达时不抛错', bad?.ok === true)
check('并在 lastError 里留下可读原因', typeof state?.lastError === 'string' && state.lastError.length > 0, state?.lastError)

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
process.exit(failed.length ? 1 : 0)
