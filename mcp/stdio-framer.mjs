const HEADER_DELIMITER = Buffer.from('\r\n\r\n', 'ascii');

/**
 * Decode MCP stdio messages by byte length. String concatenation is unsafe
 * here because Content-Length counts UTF-8 bytes while JavaScript strings
 * count UTF-16 code units.
 */
export function createMessageFramer(onMessage, onParseError, onFrame = () => {}) {
  let buffer = Buffer.alloc(0);

  function parse(body, framing) {
    try {
      const message = JSON.parse(body.toString('utf8'));
      onFrame(framing);
      onMessage(message);
    } catch {
      onParseError();
    }
  }

  function push(chunk) {
    if (!chunk || chunk.length === 0) return;
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

    while (buffer.length > 0) {
      const headerEnd = buffer.indexOf(HEADER_DELIMITER);
      if (headerEnd !== -1) {
        const header = buffer.subarray(0, headerEnd).toString('ascii');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (match) {
          const contentLength = Number.parseInt(match[1], 10);
          const bodyStart = headerEnd + HEADER_DELIMITER.length;
          if (buffer.length - bodyStart < contentLength) return;
          parse(buffer.subarray(bodyStart, bodyStart + contentLength), 'content-length');
          buffer = buffer.subarray(bodyStart + contentLength);
          continue;
        }
      }

      // Preserve an incomplete Content-Length header for the next chunk.
      const headerPrefix = buffer.subarray(0, Math.min(buffer.length, 128)).toString('ascii').trimStart();
      if (/^Content-Length\s*:/i.test(headerPrefix) && headerEnd === -1) return;

      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      const line = buffer.subarray(0, newline).toString('utf8').trim();
      buffer = buffer.subarray(newline + 1);
      if (line) parse(Buffer.from(line, 'utf8'), 'newline');
    }
  }

  return { push };
}
