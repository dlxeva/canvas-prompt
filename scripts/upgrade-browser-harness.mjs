#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import {
  availablePort,
  browserDiagnostics,
  chromePath,
  createSandbox,
  loadPlaywright,
  readLatestPromptPackage,
  readRoundArtifact,
  removeSandbox,
  sha256File,
  startVite,
  stopChild,
  waitForHttp,
  writeFakeWav,
} from './browser-test-support.mjs'

const execFile = promisify(execFileCallback)
const ROOT = resolve(import.meta.dirname, '..')
const OLD_COMMIT = 'e344b509ac9f2bf44da23434b702ce38908a1692'
const CHANGED_MODULE_URL = '/src/round-export.ts'
const CHANGED_MODULE_PATH = resolve(ROOT, 'app', 'src', 'round-export.ts')
const SYNTHETIC_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const assertions = []

function fail(message, details = undefined) {
  const error = new Error(message)
  if (details !== undefined) error.details = details
  throw error
}

function isInside(root, candidate) {
  const value = relative(resolve(root), resolve(candidate))
  return value !== '' && !value.startsWith('..') && !value.includes('..' + '/')
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, 'utf8'))
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`, { text: String(text).slice(0, 2_000) })
  }
}

async function command(commandName, args, options = {}) {
  try {
    return await execFile(commandName, args, {
      cwd: ROOT,
      maxBuffer: 128 * 1024 * 1024,
      ...options,
    })
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : ''
    fail(`${commandName} ${args.join(' ')} failed${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ''}`, {
      status: error?.status ?? null,
      code: error?.code ?? null,
    })
  }
}

async function git(repo, args, options = {}) {
  return command('git', ['-C', repo, ...args], options)
}

async function readJson(path, label = path) {
  return parseJson(await readFile(path, 'utf8'), label)
}

async function fetchJson(url, label) {
  const response = await fetch(url, { cache: 'no-store' })
  const text = await response.text()
  if (!response.ok) fail(`${label} returned HTTP ${response.status}`, { body: text.slice(0, 2_000) })
  return parseJson(text, label)
}

async function fetchChangedModule(url, label) {
  const response = await fetch(`${url}${CHANGED_MODULE_URL}`, { cache: 'no-store' })
  const text = await response.text()
  if (!response.ok || !text.trim()) fail(`${label} changed module fetch failed`, { status: response.status, body: text.slice(0, 2_000) })
  return {
    url: `${url}${CHANGED_MODULE_URL}`,
    status: response.status,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: sha256Text(text),
    containsExporter: text.includes('createRoundExporter'),
  }
}

async function readCandidateCli({ dataHome, projectDir }) {
  const result = await command(process.execPath, [resolve(ROOT, 'bin', 'canvas-prompt.mjs'), 'read', '--project', projectDir], {
    cwd: ROOT,
    env: {
      ...process.env,
      CANVAS_PROMPT_DATA_HOME: dataHome,
      CANVAS_PROMPT_PROJECT_DIR: projectDir,
      CANVAS_PROMPT_ASR: 'disabled',
      CANVAS_PROMPT_DELIVERY_MODE: 'local',
    },
  })
  return parseJson(result.stdout, 'candidate CLI read')
}

function packageFromRead(readResult, label) {
  if (!readResult || typeof readResult !== 'object' || !readResult.package?.meta?.package_id) {
    fail(`${label} omitted the package identity`, { readResult })
  }
  return readResult.package
}

function stripInlineImageData(value) {
  if (Array.isArray(value)) return value.map(stripInlineImageData)
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'url' && typeof nested === 'string' && nested.startsWith('data:image/')) {
      result.inline_data = 'excluded'
      continue
    }
    result[key] = stripInlineImageData(nested)
  }
  return result
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]))
}

function semanticallyEqual(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right))
}

function semanticSha256(value) {
  return sha256Text(JSON.stringify(canonicalValue(value)))
}

function assertPackageRead(readResult, expectedPackage, label) {
  const actual = packageFromRead(readResult, label)
  if (actual.meta.package_id !== expectedPackage.meta.package_id) {
    fail(`${label} returned the wrong package identity`, {
      expected: expectedPackage.meta.package_id,
      actual: actual.meta.package_id,
    })
  }
  const expectedWithDeliveryBoundary = stripInlineImageData(expectedPackage)
  if (!semanticallyEqual(actual, expectedWithDeliveryBoundary)) {
    fail(`${label} changed the synthetic package while reading it`, {
      expected_sha256: semanticSha256(expectedWithDeliveryBoundary),
      actual_sha256: semanticSha256(actual),
    })
  }
  if (readResult.delivery?.inline_image_data !== 'excluded') fail(`${label} did not expose the candidate MCP delivery boundary`)
  return actual
}

function syntheticPackage(packageId, createdAt, label) {
  return {
    schema_version: 'prompt-package/2.0',
    meta: {
      package_id: packageId,
      version: '2.0.0',
      created_at: createdAt,
      duration_ms: label === 'old' ? 1200 : 800,
      canvas_size: { width: 1200, height: 800, unit: 'px' },
      coordinate_system: {
        space: 'excalidraw_scene',
        unit: 'scene',
        origin: { x: 0, y: 0 },
        x_axis: 'right',
        y_axis: 'down',
      },
      tags: ['synthetic', 'upgrade-regression', label],
    },
    canvas_snapshot: {
      final: {
        url: `synthetic://${packageId}.png`,
        format: 'png',
        width: 1,
        height: 1,
        hash: sha256Bytes(SYNTHETIC_PNG),
      },
      scene_bounds: { x: 0, y: 0, width: 1200, height: 800 },
      keyframes: [],
    },
    transcript: {
      full_text: '',
      segments: [],
      language: 'zh-CN',
      alignment_status: 'unavailable',
    },
    timeline: [
      {
        event_id: `evt_${label}_stroke`,
        timestamp_ms: 200,
        event_type: 'stroke_start',
        target_id: `${label}_line`,
        metadata: { synthetic: true },
      },
      {
        event_id: `evt_${label}_stroke_end`,
        timestamp_ms: label === 'old' ? 700 : 500,
        event_type: 'stroke_end',
        target_id: `${label}_line`,
        metadata: { synthetic: true },
      },
    ],
    objects: [
      {
        object_id: `${label}_line`,
        timestamp_ms: 200,
        type: 'shape',
        bounds: { x: label === 'old' ? 140 : 420, y: 180, width: 260, height: 140 },
        properties: { shapeType: 'rectangle', synthetic: true },
        source_strokes: [`${label}_stroke`],
      },
    ],
    strokes: [
      {
        stroke_id: `${label}_stroke`,
        timestamp_ms: 200,
        duration_ms: label === 'old' ? 500 : 300,
        points: [
          { x: label === 'old' ? 140 : 420, y: 180, timestamp_ms: 200 },
          { x: label === 'old' ? 270 : 550, y: 250, timestamp_ms: label === 'old' ? 450 : 350 },
          { x: label === 'old' ? 400 : 680, y: 320, timestamp_ms: label === 'old' ? 700 : 500 },
        ],
        style: { color: '#111111', width: 2, opacity: 1 },
        semantic_type: 'drawing',
        bounding_box: { x: label === 'old' ? 140 : 420, y: 180, width: 260, height: 140 },
      },
    ],
    source: { canvas: 'excalidraw', audio: null },
  }
}

async function findOldSourceRepo() {
  const configured = process.env.CANVAS_PROMPT_PUBLIC_REPO?.trim()
  const candidates = configured ? [configured] : [ROOT]
  for (const candidate of candidates) {
    try {
      const resolved = (await git(candidate, ['rev-parse', '--show-toplevel'])).stdout.trim()
      const commit = (await git(resolved, ['rev-parse', `${OLD_COMMIT}^{commit}`])).stdout.trim()
      if (/^[a-f0-9]{40}$/.test(commit)) return { repo: resolved, commit }
    } catch {
      // Try the next local checkout. No network or remote fetch is attempted.
    }
  }
  fail(`Could not resolve old public main ${OLD_COMMIT} from a local Git checkout`)
}

async function extractOldSource({ sandbox, oldRepo, oldCommit }) {
  const sourceRoot = resolve(sandbox, 'old-main-e344b509')
  const archivePath = resolve(sandbox, 'old-main-e344b509.tar')
  await mkdir(sourceRoot, { recursive: true })
  const archive = await git(oldRepo, ['archive', '--format=tar', oldCommit], { encoding: 'buffer' })
  await writeFile(archivePath, archive.stdout)
  await command('tar', ['-xf', archivePath, '-C', sourceRoot])
  const required = [
    'app/round-archive.mjs',
    'app/round-store.mjs',
    'app/round-lifecycle.mjs',
    'prompt_package_builder/compile_runtime_package.py',
  ]
  for (const path of required) {
    if (!existsSync(resolve(sourceRoot, path))) fail(`Old source export is incomplete: ${path}`)
  }
  return {
    sourceRoot,
    archivePath,
    archiveModulePath: resolve(sourceRoot, 'app', 'round-archive.mjs'),
    compilerPath: resolve(sourceRoot, 'prompt_package_builder', 'compile_runtime_package.py'),
  }
}

async function compileWithOldSource({ compilerPath, packagePath, outputDir, sourceRoot, oldHome }) {
  const oldDataHome = resolve(oldHome, 'data-home')
  const result = await command('python3', [compilerPath, '--input', packagePath, '--output-dir', outputDir], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      HOME: oldHome,
      USERPROFILE: oldHome,
      CANVAS_PROMPT_DATA_HOME: oldDataHome,
    },
  })
  const engine = parseJson(result.stdout, 'old compiler output')
  if (engine.ok !== true) fail('Old compiler returned a failed engine receipt', { engine })
  return engine
}

async function produceOldArchive({ sandbox, oldRepo, oldCommit }) {
  const source = await extractOldSource({ sandbox: sandbox.sandbox, oldRepo, oldCommit })
  const oldHome = resolve(sandbox.sandbox, 'old-home')
  const oldDataHome = resolve(oldHome, 'data-home')
  const dataHome = sandbox.dataHome
  const boardDir = resolve(dataHome, '.canvas-prompt', 'board')
  const roundsDir = resolve(boardDir, 'rounds')
  const packageId = 'pp_upgrade_old_round'
  const roundPath = resolve(roundsDir, packageId)
  const latestPackagePath = resolve(boardDir, 'latest-prompt-package.json')
  await mkdir(oldDataHome, { recursive: true })
  const packageValue = syntheticPackage(packageId, '2026-01-01T00:00:00.000Z', 'old')
  const serializedPackage = `${JSON.stringify(packageValue, null, 2)}\n`
  const rawEvents = [
    { event_id: 'raw_old_begin', type: 'synthetic_stroke_start', at_ms: 200 },
    { event_id: 'raw_old_end', type: 'synthetic_stroke_end', at_ms: 700 },
  ]
  const rawNdjson = `${rawEvents.map((event) => JSON.stringify(event)).join('\n')}\n`
  const { archiveCompiledRound } = await import(`${source.archiveModulePath}?old-upgrade=${Date.now()}`)
  const engine = await archiveCompiledRound({
    roundPath,
    latestPackagePath,
    serializedPackage,
    packageId,
    durationMs: packageValue.meta.duration_ms,
    now: () => '2026-01-01T00:00:00.000Z',
    persistArtifacts: async () => {
      await mkdir(roundPath, { recursive: true })
      const compressed = gzipSync(Buffer.from(rawNdjson, 'utf8'))
      await writeFile(resolve(roundPath, 'canvas-snapshot.png'), SYNTHETIC_PNG)
      await writeFile(resolve(roundPath, 'raw-trace.ndjson.gz'), compressed)
      await writeFile(resolve(roundPath, 'raw-trace-manifest.json'), `${JSON.stringify({
        schema_version: 'synthetic-upgrade-trace-v1',
        compression: 'gzip',
        event_count: rawEvents.length,
        uncompressed_bytes: Buffer.byteLength(rawNdjson),
        compressed_bytes: compressed.byteLength,
        content_sha256: sha256Text(rawNdjson),
        retention: 'local_round_archive_only',
      }, null, 2)}\n`)
      return { snapshotPath: resolve(roundPath, 'canvas-snapshot.png'), rawTracePath: resolve(roundPath, 'raw-trace.ndjson.gz') }
    },
    compileCore: (packagePath) => compileWithOldSource({
      compilerPath: source.compilerPath,
      packagePath,
      outputDir: resolve(roundPath, 'engine'),
      sourceRoot: source.sourceRoot,
      oldHome,
    }),
  })
  if (engine.engine?.ok !== true) fail('Old archive/compiler did not produce a successful archive', { engine })
  const packagePath = resolve(roundPath, 'prompt-package.json')
  const latestPath = latestPackagePath
  const archiveBytes = await readFile(packagePath)
  const latestBytes = await readFile(latestPath)
  if (!archiveBytes.equals(latestBytes)) fail('Old archive latest pointer is not byte-identical to its immutable package')
  return {
    source,
    oldHome,
    oldDataHome,
    packageId,
    packageValue,
    serializedPackage,
    packagePath,
    roundPath,
    latestPath,
    packageSha256: sha256Bytes(archiveBytes),
    tree: await snapshotTree(roundPath),
    engine,
    oldArchiveModuleSha256: await sha256File(source.archiveModulePath),
    oldCompilerSha256: await sha256File(source.compilerPath),
  }
}

async function snapshotTree(root) {
  const result = {}
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name)
      const key = relative(root, path)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const bytes = await readFile(path)
        result[key] = { bytes: bytes.byteLength, sha256: sha256Bytes(bytes) }
      }
    }
  }
  await visit(root)
  return result
}

function requirePathEvidence(assertions, name, condition, details) {
  const assertion = { name, ok: Boolean(condition), ...(details === undefined ? {} : { details }) }
  assertions.push(assertion)
  if (!assertion.ok) fail(`Assertion failed: ${name}`, details)
}

async function candidateIdentity(origin, label) {
  const identity = await fetchJson(`${origin}/api/runtime-identity`, `${label} runtime identity`)
  return identity
}

async function candidateModuleFromPage(page, origin, label) {
  const module = await page.evaluate(async (path) => {
    const response = await fetch(path, { cache: 'no-store' })
    return { status: response.status, text: await response.text() }
  }, CHANGED_MODULE_URL)
  if (module.status !== 200 || !module.text.trim()) fail(`${label} browser module fetch failed`, { status: module.status })
  return {
    url: `${origin}${CHANGED_MODULE_URL}`,
    status: module.status,
    bytes: Buffer.byteLength(module.text, 'utf8'),
    sha256: sha256Text(module.text),
    containsExporter: module.text.includes('createRoundExporter'),
  }
}

function assertBrowserDiagnostics(diagnostics, label) {
  const expectedReceiptMiss = (entry) => entry.includes('http 404:') && entry.includes('/api/round-receipt/')
  const unexpectedHttpErrors = diagnostics.httpErrors.filter((entry) => !expectedReceiptMiss(entry))
  if (diagnostics.errors.length > 0 || unexpectedHttpErrors.length > 0) {
    fail(`${label} reported unexpected browser diagnostics`, {
      errors: diagnostics.errors,
      http_errors: unexpectedHttpErrors,
    })
  }
}

async function waitForStartButton(page) {
  const button = page.getByRole('button', { name: '开始推演' })
  await button.waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForFunction(() => {
    const candidate = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('开始推演'))
    return candidate instanceof HTMLButtonElement && !candidate.disabled
  }, undefined, { timeout: 20_000 })
  return button
}

async function drawSyntheticLine(page) {
  const tool = page.getByRole('button', { name: '画笔' })
  await tool.click()
  const canvas = page.locator('.spike-canvas .excalidraw__canvas').first()
  await canvas.waitFor({ state: 'visible', timeout: 15_000 })
  const box = await canvas.boundingBox()
  if (!box) fail('Candidate browser drawing surface has no bounding box')
  const startX = box.x + box.width * 0.28
  const startY = box.y + box.height * 0.28
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + box.width * 0.18, startY + box.height * 0.12, { steps: 8 })
  await page.mouse.move(startX + box.width * 0.34, startY - box.height * 0.08, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(150)
}

async function createCandidateRound(page) {
  await (await waitForStartButton(page)).click()
  await page.getByText('录音中', { exact: false }).waitFor({ state: 'visible', timeout: 15_000 })
  await drawSyntheticLine(page)
  await page.getByRole('button', { name: '结束推演' }).click()
  await page.getByRole('button', { name: '开始下一轮' }).waitFor({ state: 'visible', timeout: 60_000 })
}

async function inspectCandidateRound({ dataHome, packageId, oldPackageId = null }) {
  const roundPath = resolve(dataHome, '.canvas-prompt', 'board', 'rounds', packageId)
  const manifest = await readJson(resolve(roundPath, 'round.json'), `candidate manifest ${packageId}`)
  const rawPackage = await readJson(resolve(roundPath, 'prompt-package.json'), `candidate package ${packageId}`)
  const files = await readdir(roundPath)
  if (manifest.package_id !== packageId || rawPackage.meta?.package_id !== packageId) fail(`Candidate round ${packageId} identity is inconsistent`)
  if (manifest.engine?.ok !== true) fail(`Candidate round ${packageId} compiler failed`, { engine: manifest.engine })
  if (oldPackageId && packageId === oldPackageId) fail('Candidate next round reused the old package identity')
  const transcriptIsUnavailable = rawPackage.transcript === null
    || (rawPackage.transcript?.alignment_status === 'unavailable' && rawPackage.transcript?.segments?.length === 0)
  if (!transcriptIsUnavailable) {
    fail(`Candidate ASR-off round ${packageId} unexpectedly contains a transcript`, { transcript: rawPackage.transcript })
  }
  const traceManifest = await readJson(resolve(roundPath, 'raw-trace-manifest.json'), `candidate trace manifest ${packageId}`)
  if (!(traceManifest.event_count > 0)) fail(`Candidate round ${packageId} has no synthetic interaction trace`)
  return { roundPath, manifest, rawPackage, files, traceManifest }
}

async function main() {
  const sandbox = await createSandbox('canvas-prompt-upgrade-regression-')
  let server = null
  let browser = null
  let restartedServer = null
  let restartedBrowser = null
  try {
    const { repo: oldRepo, commit: oldCommit } = await findOldSourceRepo()
    const old = await produceOldArchive({ sandbox, oldRepo, oldCommit })
    const candidateSourceSha = (await git(ROOT, ['rev-parse', 'HEAD'])).stdout.trim()
    const candidateTreeSha = (await git(ROOT, ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
    const candidateModuleSourceSha256 = await sha256File(CHANGED_MODULE_PATH)
    const candidateCwd = resolve(ROOT, 'app')
    const realHome = homedir()
    const expectedProjectDir = await realpath(sandbox.projectDir)
    const expectedProjectHash = sha256Text(expectedProjectDir)
    const expectedStorageScopeKey = sha256Text(resolve(sandbox.dataHome, '.canvas-prompt', 'board'))

    requirePathEvidence(assertions, 'old_commit_is_exact_public_main', oldCommit === OLD_COMMIT, { old_commit: oldCommit })
    requirePathEvidence(assertions, 'changed_module_did_not_exist_in_old_source', !existsSync(resolve(old.source.sourceRoot, 'app', 'src', 'round-export.ts')))
    requirePathEvidence(assertions, 'old_archive_and_compiler_use_sandbox_paths', [old.source.sourceRoot, old.oldHome, old.oldDataHome, old.packagePath, old.roundPath, old.latestPath].every((path) => isInside(sandbox.sandbox, path)), {
      sandbox: sandbox.sandbox,
      source_root: old.source.sourceRoot,
      package_path: old.packagePath,
      latest_path: old.latestPath,
    })
    requirePathEvidence(assertions, 'old_home_is_not_real_home', old.oldHome !== realHome && old.oldDataHome !== resolve(realHome, '.canvas-prompt'), {
      old_home: old.oldHome,
      process_home: realHome,
      old_data_home: old.oldDataHome,
    })
    requirePathEvidence(assertions, 'candidate_source_sha_is_known', /^[a-f0-9]{40}$/.test(candidateSourceSha), { candidate_source_sha: candidateSourceSha })
    requirePathEvidence(assertions, 'candidate_tree_sha_is_known', /^[a-f0-9]{40}$/.test(candidateTreeSha), { candidate_tree_sha: candidateTreeSha })
    requirePathEvidence(assertions, 'candidate_runtime_cwd_is_known', existsSync(candidateCwd) && isInside(ROOT, candidateCwd), { candidate_runtime_cwd: candidateCwd })
    requirePathEvidence(assertions, 'changed_module_source_hash_is_known', /^[a-f0-9]{64}$/.test(candidateModuleSourceSha256), { changed_module: CHANGED_MODULE_PATH, sha256: candidateModuleSourceSha256 })

    const firstPort = await availablePort()
    const firstOrigin = `http://127.0.0.1:${firstPort}`
    server = startVite({ port: firstPort, dataHome: sandbox.dataHome, projectDir: sandbox.projectDir })
    await waitForHttp(`${firstOrigin}/`, server.child)
    const firstIdentity = await candidateIdentity(firstOrigin, 'initial candidate')
    requirePathEvidence(assertions, 'initial_runtime_is_candidate_local_visual_only', firstIdentity.delivery_mode === 'local' && firstIdentity.asr_enabled === false, { identity: firstIdentity })
    requirePathEvidence(assertions, 'initial_runtime_has_single_board_scope', firstIdentity.storage_kind === 'single_board' && firstIdentity.storage_scope_key, { identity: firstIdentity })
    requirePathEvidence(assertions, 'initial_runtime_identity_isolation_is_exact', firstIdentity.project_dir === expectedProjectDir && firstIdentity.project_hash === expectedProjectHash && firstIdentity.storage_scope_key === expectedStorageScopeKey, {
      expected_project_dir: expectedProjectDir,
      actual_project_dir: firstIdentity.project_dir,
      expected_project_hash: expectedProjectHash,
      actual_project_hash: firstIdentity.project_hash,
      expected_storage_scope_key: expectedStorageScopeKey,
      actual_storage_scope_key: firstIdentity.storage_scope_key,
    })
    requirePathEvidence(assertions, 'initial_port_is_ephemeral', firstPort !== 43223 && firstPort !== 4173, { port: firstPort })

    const mcpOldBeforeBrowser = await readLatestPromptPackage({ dataHome: sandbox.dataHome, projectDir: sandbox.projectDir })
    const cliOldBeforeBrowser = await readCandidateCli({ dataHome: sandbox.dataHome, projectDir: sandbox.projectDir })
    assertPackageRead(mcpOldBeforeBrowser, old.packageValue, 'candidate MCP read before browser round')
    assertPackageRead(cliOldBeforeBrowser, old.packageValue, 'candidate CLI read before browser round')
    requirePathEvidence(assertions, 'candidate_reads_exact_old_identity_before_browser_round', mcpOldBeforeBrowser.package.meta.package_id === old.packageId && cliOldBeforeBrowser.package.meta.package_id === old.packageId, {
      mcp_package_id: mcpOldBeforeBrowser.package.meta.package_id,
      cli_package_id: cliOldBeforeBrowser.package.meta.package_id,
      old_package_id: old.packageId,
    })
    requirePathEvidence(assertions, 'candidate_reads_exact_old_content_before_browser_round', semanticallyEqual(mcpOldBeforeBrowser.package, old.packageValue) && semanticallyEqual(cliOldBeforeBrowser.package, old.packageValue), {
      old_package_sha256: old.packageSha256,
    })

    const { chromium } = await loadPlaywright()
    const fakeWavPath = resolve(sandbox.projectDir, 'synthetic-upgrade-audio.wav')
    await writeFakeWav(fakeWavPath)
    browser = await chromium.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${fakeWavPath}`,
      ],
    })
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 720 } })
    await context.route('http://127.0.0.1:18080/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'disabled', whisper_loaded: false, canvas_prompt_asr: false }) })
    })
    const page = await context.newPage()
    const diagnostics = browserDiagnostics(page)
    await page.goto(firstOrigin)
    await page.locator('main.spike-shell').waitFor({ state: 'visible', timeout: 15_000 })
    const browserIdentity = await page.evaluate(async () => (await fetch('/api/runtime-identity', { cache: 'no-store' })).json())
    const browserModule = await candidateModuleFromPage(page, firstOrigin, 'initial candidate')
    requirePathEvidence(assertions, 'browser_runtime_identity_matches_candidate', browserIdentity.delivery_mode === 'local' && browserIdentity.asr_enabled === false && browserIdentity.storage_kind === 'single_board', { identity: browserIdentity })
    requirePathEvidence(assertions, 'browser_fetched_changed_module_is_candidate_code', browserModule.status === 200 && browserModule.bytes > 0 && browserModule.containsExporter && /^[a-f0-9]{64}$/.test(browserModule.sha256), browserModule)
    await createCandidateRound(page)
    assertBrowserDiagnostics(diagnostics, 'initial candidate browser')

    const newPackageEnvelope = await readLatestPromptPackage({ dataHome: sandbox.dataHome, projectDir: sandbox.projectDir })
    const newPackageId = packageFromRead(newPackageEnvelope, 'candidate MCP read after browser round').meta.package_id
    const newRound = await inspectCandidateRound({ dataHome: sandbox.dataHome, packageId: newPackageId, oldPackageId: old.packageId })
    requirePathEvidence(assertions, 'candidate_browser_created_distinct_new_round', newPackageId !== old.packageId && newRound.manifest.engine.ok === true, { old_package_id: old.packageId, new_package_id: newPackageId })
    requirePathEvidence(assertions, 'candidate_browser_round_is_synthetic_with_asr_off', newRound.rawPackage.transcript === null || (newRound.rawPackage.transcript?.alignment_status === 'unavailable' && newRound.rawPackage.transcript?.segments?.length === 0), {
      files: newRound.files,
      transcript: newRound.rawPackage.transcript,
      source_audio: newRound.rawPackage.source?.audio ?? null,
    })
    const cliNewBeforeRestart = await readCandidateCli({ dataHome: sandbox.dataHome, projectDir: sandbox.projectDir })
    assertPackageRead(newPackageEnvelope, newRound.rawPackage, 'candidate MCP read after browser round')
    assertPackageRead(cliNewBeforeRestart, newRound.rawPackage, 'candidate CLI read after browser round')
    requirePathEvidence(assertions, 'candidate_mcp_cli_read_new_identity', newPackageEnvelope.package.meta.package_id === newPackageId && cliNewBeforeRestart.package.meta.package_id === newPackageId, {
      mcp_package_id: newPackageEnvelope.package.meta.package_id,
      cli_package_id: cliNewBeforeRestart.package.meta.package_id,
      new_package_id: newPackageId,
    })

    await browser.close()
    browser = null
    await stopChild(server.child)
    server = null

    const afterBrowserOldTree = await snapshotTree(old.roundPath)
    requirePathEvidence(assertions, 'old_archive_is_byte_stable_after_candidate_round', JSON.stringify(afterBrowserOldTree) === JSON.stringify(old.tree), { before: old.tree, after: afterBrowserOldTree })
    requirePathEvidence(assertions, 'old_immutable_package_bytes_are_stable_after_candidate_round', await sha256File(old.packagePath) === old.packageSha256, {
      before: old.packageSha256,
      after: await sha256File(old.packagePath),
    })

    const restartPort = await availablePort()
    const restartOrigin = `http://127.0.0.1:${restartPort}`
    restartedServer = startVite({ port: restartPort, dataHome: sandbox.dataHome, projectDir: sandbox.projectDir })
    await waitForHttp(`${restartOrigin}/`, restartedServer.child)
    const restartedIdentity = await candidateIdentity(restartOrigin, 'restarted candidate')
    const restartedModule = await fetchChangedModule(restartOrigin, 'restarted candidate')
    requirePathEvidence(assertions, 'restart_uses_another_ephemeral_port', restartPort !== firstPort && restartPort !== 43223 && restartPort !== 4173, { first_port: firstPort, restart_port: restartPort })
    requirePathEvidence(assertions, 'restart_identity_preserves_candidate_provenance', restartedIdentity.project_dir === expectedProjectDir && restartedIdentity.project_hash === expectedProjectHash && restartedIdentity.storage_scope_key === expectedStorageScopeKey && restartedIdentity.storage_scope_key === firstIdentity.storage_scope_key && restartedIdentity.delivery_mode === 'local' && restartedIdentity.asr_enabled === false, { before: firstIdentity, after: restartedIdentity })
    requirePathEvidence(assertions, 'restart_serves_changed_candidate_module', restartedModule.status === 200 && restartedModule.containsExporter && /^[a-f0-9]{64}$/.test(restartedModule.sha256), restartedModule)

    const mcpNewAfterRestart = await readLatestPromptPackage({ dataHome: sandbox.dataHome, projectDir: sandbox.projectDir })
    const cliNewAfterRestart = await readCandidateCli({ dataHome: sandbox.dataHome, projectDir: sandbox.projectDir })
    assertPackageRead(mcpNewAfterRestart, newRound.rawPackage, 'candidate MCP read new round after restart')
    assertPackageRead(cliNewAfterRestart, newRound.rawPackage, 'candidate CLI read new round after restart')
    const oldManifestAfterRestart = parseJson(await readRoundArtifact({ dataHome: sandbox.dataHome, projectDir: sandbox.projectDir, packageId: old.packageId, artifact: 'manifest' }), 'old manifest MCP read after restart')
    const oldCompactAfterRestart = parseJson(await readRoundArtifact({ dataHome: sandbox.dataHome, projectDir: sandbox.projectDir, packageId: old.packageId, artifact: 'compact_package' }), 'old compact package MCP read after restart')
    const newManifestAfterRestart = parseJson(await readRoundArtifact({ dataHome: sandbox.dataHome, projectDir: sandbox.projectDir, packageId: newPackageId, artifact: 'manifest' }), 'new manifest MCP read after restart')
    requirePathEvidence(assertions, 'restart_mcp_reads_old_round_identity_and_compiled_artifact', oldManifestAfterRestart.package_id === old.packageId && oldManifestAfterRestart.engine?.ok === true && oldCompactAfterRestart?.process_ir_summary?.source_provenance?.package_id === old.packageId, {
      old_manifest_package_id: oldManifestAfterRestart.package_id,
      old_compact_provenance: oldCompactAfterRestart?.process_ir_summary?.source_provenance,
    })
    requirePathEvidence(assertions, 'restart_mcp_reads_new_round_identity_and_compiled_artifact', mcpNewAfterRestart.package.meta.package_id === newPackageId && newManifestAfterRestart.package_id === newPackageId && newManifestAfterRestart.engine?.ok === true, {
      new_package_id: mcpNewAfterRestart.package.meta.package_id,
      new_manifest_package_id: newManifestAfterRestart.package_id,
    })
    const afterRestartOldTree = await snapshotTree(old.roundPath)
    requirePathEvidence(assertions, 'old_archive_is_byte_stable_after_restart', JSON.stringify(afterRestartOldTree) === JSON.stringify(old.tree), { before: old.tree, after: afterRestartOldTree })
    requirePathEvidence(assertions, 'old_and_new_round_directories_remain_distinct', old.roundPath !== newRound.roundPath && isInside(sandbox.dataHome, old.roundPath) && isInside(sandbox.dataHome, newRound.roundPath), { old_round: old.roundPath, new_round: newRound.roundPath })

    restartedBrowser = await chromium.launch({ headless: true, executablePath: chromePath })
    const restartedContext = await restartedBrowser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 720 } })
    await restartedContext.route('http://127.0.0.1:18080/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'disabled', whisper_loaded: false, canvas_prompt_asr: false }) })
    })
    const restartedPage = await restartedContext.newPage()
    const restartedDiagnostics = browserDiagnostics(restartedPage)
    await restartedPage.goto(restartOrigin)
    await restartedPage.locator('main.spike-shell').waitFor({ state: 'visible', timeout: 15_000 })
    const restartedBrowserIdentity = await restartedPage.evaluate(async () => (await fetch('/api/runtime-identity', { cache: 'no-store' })).json())
    const restartedBrowserModule = await candidateModuleFromPage(restartedPage, restartOrigin, 'restarted candidate browser')
    await restartedPage.getByRole('button', { name: '更多' }).click()
    await restartedPage.getByRole('button', { name: '本地档案' }).click()
    await restartedPage.locator('.storage-item').nth(1).waitFor({ state: 'visible', timeout: 15_000 })
    const archiveItems = await restartedPage.locator('.storage-item').count()
    assertBrowserDiagnostics(restartedDiagnostics, 'restarted candidate browser')
    requirePathEvidence(assertions, 'restarted_browser_sees_both_rounds', archiveItems === 2, { archive_items: archiveItems })
    requirePathEvidence(assertions, 'restarted_browser_identity_and_module_remain_candidate_bound', restartedBrowserIdentity.storage_scope_key === firstIdentity.storage_scope_key && restartedBrowserModule.sha256 === browserModule.sha256, {
      before_identity: browserIdentity,
      after_identity: restartedBrowserIdentity,
      before_module_sha256: browserModule.sha256,
      after_module_sha256: restartedBrowserModule.sha256,
    })

    return {
      ok: true,
      assertions,
      old_main: {
        commit: oldCommit,
        source_repo: oldRepo,
        source_root: old.source.sourceRoot,
        archive_data_home: sandbox.dataHome,
        archive_module_sha256: old.oldArchiveModuleSha256,
        compiler_sha256: old.oldCompilerSha256,
        package_id: old.packageId,
        package_sha256: old.packageSha256,
        round_path: old.roundPath,
        old_home: old.oldHome,
        old_data_home: old.oldDataHome,
        source_functions_used: ['app/round-archive.mjs:archiveCompiledRound', 'prompt_package_builder/compile_runtime_package.py'],
      },
      candidate: {
        source_sha: candidateSourceSha,
        tree_sha: candidateTreeSha,
        runtime_cwd: candidateCwd,
        changed_module_path: CHANGED_MODULE_PATH,
        changed_module_source_sha256: candidateModuleSourceSha256,
        fetched_changed_module_sha256: browserModule.sha256,
        fetched_changed_module_after_restart_sha256: restartedModule.sha256,
        runtime_identity_before_restart: firstIdentity,
        runtime_identity_after_restart: restartedIdentity,
        first_port: firstPort,
        restart_port: restartPort,
      },
      rounds: {
        old_package_id: old.packageId,
        new_package_id: newPackageId,
        old_archive_tree: old.tree,
        new_round_path: newRound.roundPath,
      },
      boundaries: {
        data_home: sandbox.dataHome,
        project_dir: sandbox.projectDir,
        asr: 'disabled',
        delivery_mode: 'local',
        synthetic_only: true,
        network_upload: false,
        cache_or_live_board_restart: false,
      },
    }
  } finally {
    await browser?.close().catch(() => undefined)
    await restartedBrowser?.close().catch(() => undefined)
    await stopChild(server?.child).catch(() => undefined)
    await stopChild(restartedServer?.child).catch(() => undefined)
    await removeSandbox(sandbox.sandbox).catch(() => undefined)
  }
}

try {
  const report = await main()
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    fail_closed: true,
    assertions,
    error: error instanceof Error ? error.message : String(error),
    details: error?.details ?? null,
  }, null, 2)}\n`)
  process.exitCode = 1
}
