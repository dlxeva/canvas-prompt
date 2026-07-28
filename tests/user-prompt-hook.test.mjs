import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { threadScopeKey } from '../app/conversation-scope.mjs'
import { buildUserPromptContext } from '../hooks/canvas-prompt-user-prompt.mjs'

async function fixture() {
  const project = await mkdtemp(resolve(tmpdir(), 'canvas-prompt-hook-'))
  const sessionId = '019fa-hook-session-12345678'
  const root = resolve(project, '.canvas-prompt', 'threads', threadScopeKey(sessionId))
  const packageId = 'pp_hook_fixture'
  const round = resolve(root, 'rounds', packageId)
  await mkdir(resolve(round, 'engine'), { recursive: true })
  await writeFile(resolve(root, 'latest-prompt-package.json'), JSON.stringify({ meta: { package_id: packageId } }))
  await writeFile(resolve(round, 'engine', 'compact-package.json'), JSON.stringify({
    meta: { package_id: packageId },
    transcript: '这是本轮画布的语音证据。',
    compact_caption_summary: [{ timestamp_start_ms: 0, timestamp_end_ms: 1000, summary: '先画一个结构' }],
    semantic_events: [],
    process_ir_summary: { observation_count: 3 },
    structural_observations: { reference_candidates: [{ reference_id: 'ref_1' }], handdrawn_cross_candidates: [] },
    constraints: ['evidence first'],
  }))
  return { project, sessionId, root, packageId }
}

test('UserPromptSubmit attaches exactly one completed round from the current Codex session', async (t) => {
  const data = await fixture()
  t.after(() => rm(data.project, { recursive: true, force: true }))
  const input = { hook_event_name: 'UserPromptSubmit', session_id: data.sessionId, cwd: data.project, prompt: '你怎么看？' }
  const context = await buildUserPromptContext(input)
  assert.match(context, /automatically attached/)
  assert.match(context, /pp_hook_fixture/)
  assert.match(context, /这是本轮画布的语音证据/)
  assert.equal(await buildUserPromptContext(input), null)
  const receipt = JSON.parse(await readFile(resolve(data.root, 'continuation-receipts', `${data.packageId}.json`), 'utf8'))
  assert.equal(receipt.package_id, data.packageId)
  assert.equal(receipt.session_id, data.sessionId)
})

test('UserPromptSubmit exposes a session binding when a Canvas opening prompt has no completed round', async (t) => {
  const project = await mkdtemp(resolve(tmpdir(), 'canvas-prompt-hook-binding-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  const context = await buildUserPromptContext({ hook_event_name: 'UserPromptSubmit', session_id: '019fa-hook-binding-12345678', cwd: project, prompt: '打开 Canvas Prompt' })
  assert.match(context, /CANVAS_PROMPT_HOST_SESSION_ID=019fa-hook-binding-12345678/)
})

test('UserPromptSubmit does not manufacture continuation context from an invalid session', async () => {
  const context = await buildUserPromptContext({ hook_event_name: 'UserPromptSubmit', session_id: 'bad', cwd: '/tmp', prompt: '你怎么看' })
  assert.equal(context, null)
})
