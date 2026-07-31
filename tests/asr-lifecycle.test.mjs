import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const script = resolve('scripts/start-asr.sh')

function sourceLifecycle(commands) {
  return execFileSync('bash', ['-c', `
    export CANVAS_PROMPT_ASR_TEST_ONLY=1
    source ${JSON.stringify(script)}
    ${commands}
  `], { encoding: 'utf8' })
}

test('managed ASR defaults to the dedicated shared-runtime port', () => {
  assert.equal(sourceLifecycle('printf %s "$PORT"'), '18080')
})

test('legacy reaper only targets positively identified Canvas Prompt ASR processes', () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'canvas-asr-reaper-')), 'killed')
  sourceLifecycle(`
    PORT=18094
    curl() { [[ "$*" == *':18093/health'* ]] && printf '%s' '{"canvas_prompt_asr":true}'; }
    lsof() { [[ "$*" == *':18093'* ]] && printf '%s\\n' 4242; }
    ps() { printf '%s\\n' '/Users/example/.codex/plugins/cache/canvas-prompt/canvas-prompt/old/runtime/asr-server.py --host 127.0.0.1 --port 18093'; }
    kill() { printf '%s' "$1" > ${JSON.stringify(marker)}; }
    reap_legacy_managed_asr
  `)
  assert.equal(readFileSync(marker, 'utf8'), '4242')
})

test('legacy reaper refuses to kill an unrelated listener', () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'canvas-asr-reaper-safe-')), 'killed')
  sourceLifecycle(`
    PORT=18094
    curl() { [[ "$*" == *':18093/health'* ]] && printf '%s' '{"canvas_prompt_asr":true}'; }
    lsof() { [[ "$*" == *':18093'* ]] && printf '%s\\n' 4242; }
    ps() { printf '%s\\n' '/Applications/Other.app/Contents/MacOS/other-service'; }
    kill() { printf '%s' "$1" > ${JSON.stringify(marker)}; }
    reap_legacy_managed_asr
    test ! -e ${JSON.stringify(marker)}
  `)
})
