import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageFramer } from './stdio-framer.mjs';

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii'), body]);
}

test('parses consecutive UTF-8 Content-Length frames by byte length', () => {
  const received = [];
  const framings = [];
  const framer = createMessageFramer((message) => received.push(message), () => assert.fail('unexpected parse error'), (kind) => framings.push(kind));
  const payload = Buffer.concat([frame({ id: 1, text: '中文 🚀' }), frame({ id: 2, text: '第二条' })]);
  for (let offset = 0; offset < payload.length; offset += 3) framer.push(payload.subarray(offset, offset + 3));
  assert.deepEqual(received, [{ id: 1, text: '中文 🚀' }, { id: 2, text: '第二条' }]);
  assert.deepEqual(framings, ['content-length', 'content-length']);
});

test('keeps a partial Content-Length header and supports newline fallback', () => {
  const received = [];
  const framer = createMessageFramer((message) => received.push(message), () => assert.fail('unexpected parse error'));
  const firstBody = Buffer.from(JSON.stringify({ id: 3, text: '中文' }), 'utf8');
  framer.push(Buffer.from(`Content-Length: ${firstBody.byteLength}\r\n`));
  assert.deepEqual(received, []);
  framer.push(Buffer.concat([Buffer.from('\r\n'), firstBody]));
  framer.push(Buffer.from('{"id":4,"text":"line"}\n'));
  assert.deepEqual(received, [{ id: 3, text: '中文' }, { id: 4, text: 'line' }]);
});
