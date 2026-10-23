/** 朗读桥 · 弹窗 */

const $ = (id) => document.getElementById(id)

function render(state) {
  const { settings, health, lastError, recent } = state
  $('enabled').checked = settings.enabled
  $('baseUrl').value = settings.baseUrl
  $('rate').value = settings.rate
  $('pollSeconds').value = settings.pollSeconds

  const dot = $('dot')
  if (health?.ok) {
    dot.className = 'dot on'
    const parts = [`宿主在线 · 待念 ${health.pending ?? 0} 条`]
    if (health.watching === false) parts.push('（未监听会话日志）')
    $('status').textContent = parts.join('')
  } else {
    dot.className = 'dot off'
    $('status').textContent = '宿主未连接 —— 检查 DSH 是否在跑、地址端口是否对'
  }

  $('err').textContent = lastError ? String(lastError).slice(0, 200) : ''

  const ul = $('recent')
  ul.innerHTML = ''
  for (const r of recent ?? []) {
    const li = document.createElement('li')
    const t = new Date(r.at).toLocaleTimeString()
    li.textContent = `${t} · ${r.result === 'end' ? '已念' : r.result} · ${r.text}`
    ul.appendChild(li)
  }
}

async function refresh() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'getState' })
    if (state?.ok) render(state)
    else $('err').textContent = state?.error ?? '读取状态失败'
  } catch (e) {
    $('err').textContent = `扩展后台没有响应：${e?.message ?? e}`
  }
}

$('save').addEventListener('click', async () => {
  const patch = {
    enabled: $('enabled').checked,
    baseUrl: $('baseUrl').value.trim() || 'http://127.0.0.1:43120',
    rate: Number($('rate').value) || 1,
    pollSeconds: Math.max(1, Number($('pollSeconds').value) || 5),
  }
  await chrome.runtime.sendMessage({ type: 'save', patch })
  await refresh()
})

$('test').addEventListener('click', async () => {
  $('status').textContent = '正在念测试句…'
  await chrome.runtime.sendMessage({ type: 'test', text: '朗读桥已经装好了，这是测试的一句话。' })
  await refresh()
})

$('poll').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'poll' })
  setTimeout(refresh, 800)
})

$('stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop' })
  $('status').textContent = '已停止'
})

refresh()
setInterval(refresh, 3000)
