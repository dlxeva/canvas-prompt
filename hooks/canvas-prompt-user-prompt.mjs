#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConversationScope, validThreadId } from '../app/conversation-scope.mjs'

const MAX_PACKAGE_BYTES = 256 * 1024
const MAX_TRANSCRIPT_CHARS = 1_600
const MAX_CAPTIONS = 12
const PACKAGE_ID = /^[A-Za-z0-9_.-]{1,200}$/

const inside = (parent, candidate) => {
  const path = resolve(candidate)
  const rel = relative(resolve(parent), path)
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !rel.startsWith('..\\'))
}

async function readJson(path, maxBytes = MAX_PACKAGE_BYTES) {
  const value = await readFile(path, 'utf8')
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error('Canvas Prompt hook artifact exceeds its read limit.')
  return JSON.parse(value)
}

async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

function conciseContinuation(compact, { packageId, packagePath, snapshotPath }) {
  const captions = Array.isArray(compact.compact_caption_summary)
    ? compact.compact_caption_summary.slice(0, MAX_CAPTIONS).map(({ timestamp_start_ms, timestamp_end_ms, summary }) => ({ timestamp_start_ms, timestamp_end_ms, summary }))
    : []
  const structural = compact.structural_observations && typeof compact.structural_observations === 'object'
    ? Object.fromEntries(Object.entries(compact.structural_observations).map(([key, value]) => [key, Array.isArray(value) ? value.length : value]).filter(([, value]) => typeof value === 'number'))
    : {}
  const evidence = {
    package_id: packageId,
    compact_package_path: packagePath,
    canvas_snapshot_path: snapshotPath,
    transcript: typeof compact.transcript === 'string' ? compact.transcript.slice(0, MAX_TRANSCRIPT_CHARS) : '',
    caption_summary: captions,
    semantic_events: Array.isArray(compact.semantic_events) ? compact.semantic_events.slice(0, 12) : [],
    process_ir_summary: compact.process_ir_summary ?? {},
    structural_observation_counts: structural,
    constraints: Array.isArray(compact.constraints) ? compact.constraints.slice(0, 12) : [],
  }
  return [
    'Canvas Prompt continuation context (automatically attached from the just-finished round in this exact Codex session):',
    'The user\'s current message is presumed to continue this round. Answer or continue their work directly from this evidence; do not ask them to say “read the canvas”.',
    'Keep observations distinct from inferences. This is an immutable local package; use the listed local paths only if more evidence is materially needed.',
    JSON.stringify(evidence),
  ].join('\n')
}

export async function buildUserPromptContext(input, { consume = true } = {}) {
  if (!input || input.hook_event_name !== 'UserPromptSubmit') return null
  if (!validThreadId(input.session_id) || typeof input.cwd !== 'string' || !input.cwd.trim()) return null

  const scope = resolveConversationScope({ projectDir: input.cwd, threadId: input.session_id })
  const latestPath = scope.latestPackagePath
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  const canvasIntent = /canvas\s*prompt|canvas|画布|白板/i.test(prompt)

  if (!existsSync(latestPath)) {
    return canvasIntent
      ? `Canvas Prompt host session binding: CANVAS_PROMPT_HOST_SESSION_ID=${input.session_id}. If you open Canvas Prompt in this turn, pass this exact value as --thread-id; never infer or substitute a different conversation ID.`
      : null
  }

  let latest
  try {
    latest = await readJson(latestPath)
  } catch {
    return null
  }
  const packageId = latest?.meta?.package_id
  if (typeof packageId !== 'string' || !PACKAGE_ID.test(packageId)) return null

  const roundPath = resolve(scope.roundsDir, packageId)
  const compactPath = resolve(roundPath, 'engine', 'compact-package.json')
  const snapshotPath = resolve(roundPath, 'canvas-snapshot.png')
  const receiptPath = resolve(scope.canvasDir, 'continuation-receipts', `${packageId}.json`)
  if (!inside(scope.canvasDir, roundPath) || !inside(roundPath, compactPath) || !inside(scope.canvasDir, receiptPath)) return null
  if (existsSync(receiptPath) || !existsSync(compactPath)) return null

  let compact
  try {
    compact = await readJson(compactPath)
  } catch {
    return null
  }
  const context = conciseContinuation(compact, {
    packageId,
    packagePath: compactPath,
    snapshotPath: existsSync(snapshotPath) ? snapshotPath : null,
  })
  if (consume) {
    await writeJsonAtomically(receiptPath, {
      schema_version: 1,
      package_id: packageId,
      session_id: input.session_id,
      injected_at: new Date().toISOString(),
      reason: 'next_user_prompt_after_completed_round',
    })
  }
  return context
}

async function main() {
  let source = ''
  for await (const chunk of process.stdin) source += chunk
  let input
  try {
    input = JSON.parse(source)
  } catch {
    process.exitCode = 0
    return
  }
  try {
    const context = await buildUserPromptContext(input)
    if (context) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })}\n`)
  } catch {
    // A continuation enhancer must never block an ordinary Codex prompt.
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
