const HEADER_SEPARATOR = Buffer.from('\r\n\r\n')

/**
 * Incrementally parses MCP stdio messages without converting the transport
 * buffer to a JavaScript string before applying Content-Length.
 */
export function createMessageFramer(onMessage, onParseError = () => {}) {
  let buffer = Buffer.alloc(0)

  const dispatch = (body) => {
    try {
      onMessage(JSON.parse(body.toString('utf8')))
    } catch (error) {
      onParseError(error)
    }
  }

  return {
    push(chunk) {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      buffer = buffer.length === 0 ? next : Buffer.concat([buffer, next])

      while (buffer.length > 0) {
        const headerEnd = buffer.indexOf(HEADER_SEPARATOR)
        if (headerEnd !== -1) {
          const header = buffer.subarray(0, headerEnd).toString('ascii')
          const match = header.match(/Content-Length:\s*(\d+)/i)
          if (match) {
            const contentLength = Number.parseInt(match[1], 10)
            const bodyStart = headerEnd + HEADER_SEPARATOR.length
            if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
              onParseError(new Error('Invalid Content-Length'))
              buffer = buffer.subarray(bodyStart)
              continue
            }
            if (buffer.length - bodyStart < contentLength) break

            const body = buffer.subarray(bodyStart, bodyStart + contentLength)
            buffer = buffer.subarray(bodyStart + contentLength)
            dispatch(body)
            continue
          }
        }

        const prefix = buffer.subarray(0, Math.min(buffer.length, 32)).toString('ascii')
        if (headerEnd === -1 && /^Content-Length:\s*/i.test(prefix)) break

        const newline = buffer.indexOf(0x0a)
        if (newline === -1) break
        const line = buffer.subarray(0, newline).toString('utf8').trim()
        buffer = buffer.subarray(newline + 1)
        if (!line) continue

        try {
          onMessage(JSON.parse(line))
        } catch (error) {
          onParseError(error)
        }
      }
    },
  }
}
