/**
 * 朗读桥 · 扩展后台
 *
 * 职责很小：定时去本地 DSH 的队列取一条话，用 chrome.tts 念出来，念完回执。
 * 所有状态都在 chrome.storage.local，service worker 被回收也不丢。
 *
 * 为什么用 chrome.tts 而不是页面里的 speechSynthesis：
 *  · speechSynthesis 必须有页面上下文、会随页面标签被挂起/静音；
 *  · chrome.tts 是扩展专用接口，后台就能发声，与页面无关。
 */

const DEFAULTS = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:43120', // DSH Web 的默认端口；可在弹窗里改
  rate: 1.0,
  volume: 1.0,
  pollSeconds: 5,
}

/** 当前是否正在念（避免重叠） */
let speaking = false
/** 上次错误，弹窗展示用 */
let lastError = ''
/** 最近念过的几条，弹窗展示用 */
let recent = []

async function getSettings() {
  const got = await chrome.storage.local.get(DEFAULTS)
  return { ...DEFAULTS, ...got }
}

async function setSettings(patch) {
  await chrome.storage.local.set(patch)
  return getSettings()
}

async function api(settings, pathSuffix, init) {
  const url = String(settings.baseUrl).replace(/\/+$/, '') + '/dsh-aloud' + pathSuffix
  const res = await fetch(url, { cache: 'no-store', ...init })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** 念一段。Promise 在念完（或失败）时 resolve。 */
function speak(text, settings) {
  return new Promise((resolve) => {
    let settled = false
    const done = (why) => {
      if (settled) return
      settled = true
      resolve(why)
    }
    try {
      chrome.tts.speak(text, {
        rate: Number(settings.rate) || 1,
        volume: Number(settings.volume) || 1,
        enqueue: false,
        onEvent: (event) => {
          if (event.type === 'end' || event.type === 'interrupted' || event.type === 'cancelled') done('end')
          if (event.type === 'error') {
            lastError = `TTS 错误：${event.errorMessage || 'unknown'}`
            done('error')
          }
        },
      })
      // 兜底：某些平台 onEvent 不稳，按字数估一个上限
      const guardMs = Math.min(180_000, Math.max(8_000, text.length * 320))
      setTimeout(() => done('timeout'), guardMs)
    } catch (e) {
      lastError = `TTS 异常：${e?.message ?? e}`
      done('error')
    }
  })
}

/** 主循环的一拍：取一条 → 念 → 回执 */
async function tick() {
  if (speaking) return
  const settings = await getSettings()
  if (!settings.enabled) return

  speaking = true
  try {
    const data = await api(settings, '/next', { method: 'GET' })
    const item = data?.item
    if (!item || !item.text) return

    const result = await speak(item.text, settings)
    recent = [{ at: Date.now(), text: item.text.slice(0, 80), result }, ...recent].slice(0, 8)
    await chrome.storage.local.set({ recent, lastError })

    // 回执：告诉宿主这条念过了（下次不会再取到）
    await api(settings, '/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id }),
    }).catch(() => {})
  } catch (e) {
    // 宿主没开 / 端口不对 都属于正常情况，不刷屏
    lastError = `连不上宿主：${e?.message ?? e}`
    await chrome.storage.local.set({ lastError })
  } finally {
    speaking = false
  }
}

// ── 调度：alarms 保底（SW 会被回收），setInterval 在被唤醒期间加密 ──────────
async function ensureAlarm() {
  const settings = await getSettings()
  const period = Math.max(0.5, Math.min(60, Number(settings.pollSeconds) / 60 || 0.5))
  await chrome.alarms.create('dsh-aloud-poll', { periodInMinutes: period })
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dsh-aloud-poll') tick()
})

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm()
  tick()
})
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm()
  tick()
})

// 被唤醒后临时加密轮询（几秒一次），SW 睡过去后由 alarms 接棒
let fast = null
function startFast() {
  if (fast) return
  fast = setInterval(tick, 5000)
}
function stopFast() {
  if (!fast) return
  clearInterval(fast)
  fast = null
}
startFast()
setTimeout(stopFast, 25_000)

// ── 弹窗消息 ────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  ;(async () => {
    try {
      if (msg?.type === 'getState') {
        const settings = await getSettings()
        let health = null
        try {
          health = await api(settings, '/health', { method: 'GET' })
        } catch { /* 宿主没开 */ }
        sendResponse({ ok: true, settings, speaking, lastError, recent, health })
        return
      }
      if (msg?.type === 'save') {
        const settings = await setSettings(msg.patch ?? {})
        await ensureAlarm()
        sendResponse({ ok: true, settings })
        return
      }
      if (msg?.type === 'test') {
        const settings = await getSettings()
        await speak(msg.text || '朗读桥已经装好了，这是测试的一句话。', settings)
        sendResponse({ ok: true })
        return
      }
      if (msg?.type === 'poll') {
        await tick()
        sendResponse({ ok: true })
        return
      }
      if (msg?.type === 'stop') {
        chrome.tts.stop()
        sendResponse({ ok: true })
        return
      }
      sendResponse({ ok: false, error: 'unknown_message' })
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e) })
    }
  })()
  return true // 保持消息通道打开（异步 sendResponse）
})
