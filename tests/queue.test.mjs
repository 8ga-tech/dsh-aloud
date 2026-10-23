import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toSpeakable, fingerprint, SpeakQueue } from '../lib/queue.js'

test('去掉围栏代码块与行内反引号', () => {
  const src = '先说结论。\n```js\nconst a = 1\n```\n行内 `x` 保留。'
  const out = toSpeakable(src)
  assert.ok(!out.includes('const a = 1'), '代码块应整块消失')
  assert.ok(out.includes('先说结论'))
  assert.ok(out.includes('行内 x 保留'), '行内代码保留内容')
  assert.ok(!out.includes('`'))
})

test('链接只留文字、图片整条丢弃', () => {
  const out = toSpeakable('看这个 [文档](https://a.b/c) 和 ![图](https://a.b/x.png) 就行')
  assert.ok(out.includes('文档'))
  assert.ok(!out.includes('https://'))
  assert.ok(!out.includes('图]'))
})

test('标题 / 引用 / 列表 / 强调记号被清除', () => {
  const out = toSpeakable('## 标题\n> 引用一句\n- 第一条\n1. 第二条\n**加粗** 和 ~~删除~~')
  assert.ok(!/[#>\-*~]/.test(out.replace(/[，。！？：；、\n]/g, '')), `还有记号残留: ${out}`)
  assert.ok(out.includes('加粗'))
  assert.ok(out.includes('删除'))
})

test('纯链接行与纯符号行被丢弃', () => {
  const out = toSpeakable('正文一句\nhttps://example.com/a/b\n---\n')
  assert.equal(out, '正文一句')
})

test('超长文本截断并加省略号', () => {
  const long = '这句话很长。'.repeat(300)
  const out = toSpeakable(long, { maxChars: 100 })
  assert.ok(out.length <= 110, `长度应在限制附近，实际 ${out.length}`)
  assert.ok(out.endsWith('……'))
})

test('空白输入得到空串', () => {
  assert.equal(toSpeakable('   \n\n  '), '')
  assert.equal(toSpeakable('```\ncode\n```'), '')
  assert.equal(toSpeakable(null), '')
  assert.equal(toSpeakable(undefined), '')
})

test('指纹稳定且区分内容', () => {
  assert.equal(fingerprint('abc'), fingerprint('abc'))
  assert.notEqual(fingerprint('abc'), fingerprint('abd'))
  assert.notEqual(fingerprint('abc'), fingerprint('abc '))
})

test('同一段话只入队一次（去重靠内容指纹）', () => {
  const q = new SpeakQueue({ now: () => 1000 })
  const a = q.push('你好呀')
  const b = q.push('你好呀')
  assert.ok(a)
  assert.equal(b, null, '完全重复应被丢弃')
  assert.equal(q.size, 1)
  // 句号不同 → 清洗结果不同 → 指纹不同 → 视为新的一句（刻意如此：
  // 标点是朗读停顿的一部分，只差标点的连续两条本来就少见）
  assert.ok(q.push('你好呀。'))
  assert.equal(q.size, 2)
})

test('洗空的内容不入队', () => {
  const q = new SpeakQueue()
  assert.equal(q.push('```\n仅代码\n```'), null)
  assert.equal(q.size, 0)
})

test('超过上限时丢最旧的', () => {
  const q = new SpeakQueue({ maxItems: 3 })
  for (let i = 0; i < 5; i += 1) q.push(`第 ${i} 句话`)
  assert.equal(q.size, 3)
  const texts = q.list('all').map((x) => x.text)
  assert.ok(!texts.includes('第 0 句话'))
  assert.ok(texts.includes('第 4 句话'))
})

test('take 依次取走并标记，没得取时返回 null', () => {
  const q = new SpeakQueue({ now: () => 2000 })
  q.push('一')
  q.push('二')
  const first = q.take()
  assert.equal(first.text, '一')
  assert.equal(typeof first.spokenAt, 'number')
  assert.equal(q.pendingCount, 1)
  const second = q.take()
  assert.equal(second.text, '二')
  assert.equal(q.take(), null)
  assert.equal(q.pendingCount, 0)
})

test('markSpoken / peek / clear 行为', () => {
  const q = new SpeakQueue()
  const item = q.push('标记我')
  assert.equal(q.peek(item.id).text, '标记我')
  assert.equal(q.markSpoken(item.id), true)
  assert.equal(q.pendingCount, 0)
  assert.equal(q.list('all').length, 1)
  assert.equal(q.markSpoken('不存在'), false)
  q.clear()
  assert.equal(q.size, 0)
  // clear 之后，同一句话不应再次入队（去重指纹仍在）
  assert.equal(q.push('标记我'), null)
  q.reset()
  assert.ok(q.push('标记我'))
})

test('sessionId / sessionTitle 被规整进条目', () => {
  const q = new SpeakQueue()
  const it = q.push('带元信息', { sessionId: 123, sessionTitle: '测试会话' })
  assert.equal(it.sessionId, '123')
  assert.equal(it.sessionTitle, '测试会话')
})

test('maxChars 会被夹到合理下界（防止配成 0 导致全空）', () => {
  const q = new SpeakQueue({ maxChars: 1 })
  assert.ok(q.push('这是一段足够长的文字用来验证下界'))
})
