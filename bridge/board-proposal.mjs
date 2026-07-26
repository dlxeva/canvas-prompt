/**
 * Future-only transport protocol for human-confirmed board proposals.
 * The active bridge does not import this module in the current MVP.
 */
export function extractBoardPlan(content) {
  const match = content.match(/```canvas-prompt-board\s*([\s\S]*?)```/)
  if (!match) return { content, boardPlan: null }
  const visibleContent = content.replace(match[0], '').trim()
  try {
    const parsed = JSON.parse(match[1])
    if (typeof parsed?.title !== 'string' || !Array.isArray(parsed.nodes)) throw new Error('invalid board plan')
    const nodes = parsed.nodes
      .filter((node) => typeof node?.text === 'string')
      .slice(0, 6)
      .map((node) => ({
        text: node.text.trim().slice(0, 180),
        kind: ['idea', 'question', 'decision'].includes(node.kind) ? node.kind : 'idea',
      }))
      .filter((node) => node.text)
    if (!nodes.length) throw new Error('empty board plan')
    return { content: visibleContent, boardPlan: { title: parsed.title.trim().slice(0, 100), nodes } }
  } catch {
    return { content: visibleContent, boardPlan: null }
  }
}
