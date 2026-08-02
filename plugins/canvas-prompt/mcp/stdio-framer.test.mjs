import test from 'node:test'
import assert from 'node:assert/strict'
import { createMessageFramer } from './stdio-framer.mjs'

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

test('parses consecutive framed requests containing multi-byte text', () => {
  const messages = []
  const errors = []
  const framer = createMessageFramer((message) => messages.push(message), (error) => errors.push(error))
  const payload = Buffer.concat([frame({ jsonrpc: '2.0', id: 1, method: 'ping', params: { text: '继续推演 🧠' } }), frame({ jsonrpc: '2.0', id: 2, method: 'ping', params: { text: '第二条中文' } })])

  for (let offset = 0; offset < payload.length; offset += 3) framer.push(payload.subarray(offset, offset + 3))

  assert.deepEqual(messages, [
    { jsonrpc: '2.0', id: 1, method: 'ping', params: { text: '继续推演 🧠' } },
    { jsonrpc: '2.0', id: 2, method: 'ping', params: { text: '第二条中文' } },
  ])
  assert.deepEqual(errors, [])
})

test('keeps a partial Content-Length header for the next chunk', () => {
  const messages = []
  const framer = createMessageFramer((message) => messages.push(message))
  const payload = frame({ jsonrpc: '2.0', id: 7, method: 'ping' })
  framer.push(payload.subarray(0, 12))
  assert.deepEqual(messages, [])
  framer.push(payload.subarray(12))
  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 7, method: 'ping' }])
})
