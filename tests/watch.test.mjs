import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLine, contentToText, isAssistantMessage, extractAssistantTexts } from '../lib/watch.js'

test('parseLine 挡住空行与坏 JSON', () => {
  assert.equal(parseLine(''), null)
  assert.equal(parseLine('   '), null)
  assert.equal(parseLine('not json'), null)
  assert.equal(parseLine('{坏}'), null)
  assert.deepEqual(parseLine('{"a":1}'), { a: 1 })
})

test('contentToText 吃字符串 / 段数组 / 对象', () => {
  assert.equal(contentToText('直接字符串'), '直接字符串')
  assert.equal(contentToText([{ type: 'text', text: '一' }, { type: 'text', text: '二' }]), '一\n二')
  assert.equal(contentToText([{ type: 'tool_use', name: 'x' }, { type: 'text', text: '可见' }]), '\n可见')
  assert.equal(contentToText({ text: '对象里的' }), '对象里的')
  assert.equal(contentToText(null), '')
  assert.equal(contentToText(42), '')
})

test('isAssistantMessage：只认带文本的完整助手消息', () => {
  assert.equal(isAssistantMessage({ role: 'assistant', content: '你好' }), true)
  assert.equal(isAssistantMessage({ role: 'user', content: '你好' }), false)
  assert.equal(isAssistantMessage({ role: 'assistant', content: '' }), false)
  assert.equal(isAssistantMessage({ role: 'assistant', content: 'x', partial: true }), false)
  assert.equal(isAssistantMessage({ role: 'assistant', content: 'x', streaming: true }), false)
  assert.equal(isAssistantMessage(null), false)
  // 嵌套在 message 里的形态也要认
  assert.equal(isAssistantMessage({ message: { role: 'assistant', content: '嵌套' } }), true)
})

test('extractAssistantTexts 按顺序挑出助手文本', () => {
  const records = [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '第一段回答' },
    { role: 'tool', content: '工具输出' },
    { role: 'assistant', content: [{ type: 'text', text: '第二段' }] },
  ]
  assert.deepEqual(extractAssistantTexts(records), ['第一段回答', '第二段'])
})

test('extractAssistantTexts 对非数组输入安全', () => {
  assert.deepEqual(extractAssistantTexts(null), [])
  assert.deepEqual(extractAssistantTexts('x'), [])
})
