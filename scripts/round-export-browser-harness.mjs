#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  availablePort,
  browserDiagnostics,
  chromePath,
  createSandbox,
  ensureAppBuild,
  loadPlaywright,
  readLatestPromptPackage,
  readRoundArtifact,
  removeSandbox,
  sha256File,
  startVite,
  stopChild,
  waitForHttp,
  writeFakeWav,
} from './browser-test-support.mjs';

const IMAGE_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function scenarioFromArgs() {
  const index = process.argv.indexOf('--scenario');
  const scenario = index === -1 ? 'all' : process.argv[index + 1];
  if (!['all', 'recovery', 'upload-retry', 'media-partial', 'smoke'].includes(scenario)) {
    throw new Error(`Unknown scenario: ${scenario ?? '(missing)'}`);
  }
  return scenario;
}

function serverFromArgs() {
  const index = process.argv.indexOf('--server');
  const server = index === -1 ? 'both' : process.argv[index + 1];
  if (!['dev', 'preview', 'both'].includes(server)) throw new Error(`Unknown server: ${server ?? '(missing)'}`);
  return server;
}

function allowedServers(server) {
  return server === 'both' ? ['dev', 'preview'] : [server];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function packageIdFromPath(pathname) {
  const match = pathname.match(/\/(?:round-receipt|round-audio|round-source-image|round-trace-segment|prompt-package-segment)\/([^/]+)/);
  return match?.[1] ?? null;
}

function createRequestCounters() {
  return {
    receipt: 0,
    sourceImage: 0,
    audio: 0,
    trace: 0,
    promptPackage: 0,
    promptPackageResume: 0,
    packageIds: new Set(),
  };
}

async function waitForStartButton(page) {
  const button = page.getByRole('button', { name: '开始推演' });
  await button.waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForFunction(() => {
    const candidate = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('开始推演'));
    return candidate instanceof HTMLButtonElement && !candidate.disabled;
  }, undefined, { timeout: 20_000 });
  return button;
}

async function drawSyntheticLine(page, offset = 0) {
  const tool = page.getByRole('button', { name: '画笔' });
  await tool.click();
  const canvas = page.locator('.spike-canvas .excalidraw__canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: 15_000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas drawing surface has no bounding box.');
  const startX = box.x + box.width * (0.24 + offset);
  const startY = box.y + box.height * 0.28;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + box.width * 0.18, startY + box.height * 0.12, { steps: 8 });
  await page.mouse.move(startX + box.width * 0.34, startY - box.height * 0.08, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

async function importSyntheticImage(page, imagePath) {
  await page.locator('input.image-file-input').setInputFiles(imagePath);
  await page.getByText(/已导入「synthetic-source\.png」/, { exact: false }).waitFor({ state: 'visible', timeout: 15_000 });
}

async function finishAndWait(page, expected = 'success', checkEndBoundary = false) {
  await page.getByRole('button', { name: '结束推演' }).click();
  if (checkEndBoundary) {
    assert(await page.getByRole('button', { name: '导入文件', exact: true }).isDisabled(), 'Import remained enabled while the ended round was compiling.');
    // Bypass the disabled button like an already queued file/drop callback.
    await page.locator('input.image-file-input').setInputFiles({ name: 'late-after-finish.png', mimeType: 'image/png', buffer: IMAGE_BYTES });
  }
  if (expected === 'retry') {
    const retry = page.getByRole('button', { name: '重新整理本轮' });
    await retry.waitFor({ state: 'visible', timeout: 45_000 });
    return retry;
  }
  await page.getByRole('button', { name: '开始下一轮' }).waitFor({ state: 'visible', timeout: 60_000 });
  return null;
}

async function inspectRound({ dataHome, projectDir, packageId, imagePath, expectedSourceUpload, expectedAudioUpload }) {
  const board = resolve(dataHome, '.canvas-prompt', 'board');
  const roundsDir = resolve(board, 'rounds');
  const roundPath = resolve(roundsDir, packageId);
  const files = await readdir(roundPath);
  const manifest = JSON.parse(await readFile(resolve(roundPath, 'round.json'), 'utf8'));
  const rawPackage = JSON.parse(await readFile(resolve(roundPath, 'prompt-package.json'), 'utf8'));
  const engine = manifest.engine;
  assert(manifest.package_id === packageId, `Round manifest identity mismatch for ${packageId}.`);
  assert(rawPackage.meta?.package_id === packageId, `Prompt Package identity mismatch for ${packageId}.`);
  assert(engine?.ok === true, `Real Python compiler did not complete for ${packageId}: ${engine?.error || 'unknown error'}`);
  assert(engine.process_ir_path && engine.compact_package_path, `Compiler receipt omitted engine paths for ${packageId}.`);
  assert(files.includes('canvas-snapshot.png'), `Round ${packageId} has no canvas snapshot.`);
  const traceManifest = JSON.parse(await readFile(resolve(roundPath, 'raw-trace-manifest.json'), 'utf8'));
  assert(traceManifest.event_count > 0, `Round ${packageId} has no persisted interaction trace.`);

  const sourceDir = resolve(roundPath, 'source-images');
  const sourceFiles = await readdir(sourceDir).catch(() => []);
  const audioFiles = files.filter((name) => name.startsWith('audio.'));
  if (expectedSourceUpload) {
    assert(sourceFiles.length === 1, `Expected one archived source image, got ${sourceFiles.length}.`);
    const sourceSha = await sha256File(resolve(sourceDir, sourceFiles[0]));
    const expectedSha = createHash('sha256').update(await readFile(imagePath)).digest('hex');
    assert(sourceSha === expectedSha, 'Archived source image bytes changed during round export.');
  }
  if (expectedAudioUpload) {
    assert(audioFiles.length === 1, `Expected one archived audio file, got ${audioFiles.length}.`);
    const audioInfo = await readFile(resolve(roundPath, audioFiles[0]));
    assert(audioInfo.byteLength > 0, 'Archived audio file is empty.');
  }

  const mcpLatest = await readLatestPromptPackage({ dataHome, projectDir });
  assert(mcpLatest.package?.meta?.package_id === packageId, `MCP latest read did not return ${packageId}.`);
  assert(mcpLatest.delivery?.inline_image_data === 'excluded', 'MCP latest read did not preserve its inline-image boundary.');
  const compact = JSON.parse(await readRoundArtifact({ dataHome, projectDir, packageId, artifact: 'compact_package' }));
  const processIr = JSON.parse(await readRoundArtifact({ dataHome, projectDir, packageId, artifact: 'process_ir' }));
  assert(compact && processIr, `MCP progressive artifact reads failed for ${packageId}.`);
  return { board, roundPath, manifest, rawPackage, mcpLatest, compact, processIr, sourceFiles, audioFiles };
}

async function runSmoke({ mode }) {
  const sandbox = await createSandbox(`canvas-prompt-round-smoke-${mode}-`);
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = startVite({ mode, port, dataHome: sandbox.dataHome, projectDir: sandbox.projectDir });
  let browser;
  try {
    await waitForHttp(`${origin}/`, server.child);
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ headless: true, executablePath: chromePath });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await context.route('http://127.0.0.1:18080/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'disabled', whisper_loaded: false, canvas_prompt_asr: false }) });
    });
    const page = await context.newPage();
    const diagnostics = browserDiagnostics(page);
    await page.goto(origin);
    await page.locator('main.spike-shell').waitFor({ state: 'visible', timeout: 15_000 });
    const result = await page.evaluate(async () => {
      const identityResponse = await fetch('/api/runtime-identity', { cache: 'no-store' });
      const identity = await identityResponse.json();
      const sessionResponse = await fetch('/api/runtime-session', { method: 'POST' });
      const session = await sessionResponse.json();
      const roundsResponse = await fetch('/api/rounds', { headers: { 'x-canvas-prompt-token': session.token } });
      return { identity, sessionIssued: typeof session.token === 'string' && session.token.length > 0, sessionStatus: sessionResponse.status, roundsStatus: roundsResponse.status, rounds: await roundsResponse.json() };
    });
    assert(result.identity.delivery_mode === 'local', `Preview/dev identity did not expose local handoff (${mode}).`);
    assert(result.identity.asr_enabled === false, `Preview/dev identity did not expose ASR disabled (${mode}).`);
    assert(result.sessionStatus === 200 && result.sessionIssued, `Runtime session was not issued in ${mode}.`);
    assert(result.roundsStatus === 200 && Array.isArray(result.rounds?.rounds), `Protected /api/rounds smoke failed in ${mode}.`);
    diagnostics.assertClean();
    return { ok: true, scenario: 'smoke', server: mode, origin, asr_enabled: result.identity.asr_enabled, delivery_mode: result.identity.delivery_mode, protected_rounds_status: result.roundsStatus };
  } finally {
    await browser?.close().catch(() => undefined);
    await stopChild(server.child);
    await removeSandbox(sandbox.sandbox);
  }
}

async function runRound({ mode, behavior }) {
  const sandbox = await createSandbox(`canvas-prompt-round-${behavior}-${mode}-`);
  const imagePath = resolve(sandbox.projectDir, 'synthetic-source.png');
  const wavPath = resolve(sandbox.projectDir, 'synthetic-audio.wav');
  await writeFile(imagePath, IMAGE_BYTES);
  await writeFakeWav(wavPath);
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = startVite({ mode, port, dataHome: sandbox.dataHome, projectDir: sandbox.projectDir });
  const counters = createRequestCounters();
  let browser;
  let debugPage;
  let debugDiagnostics;
  try {
    await waitForHttp(`${origin}/`, server.child);
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${wavPath}`,
      ],
    });
    const context = await browser.newContext({ locale: 'zh-CN', permissions: ['microphone'], viewport: { width: 1280, height: 720 } });
    await context.route('http://127.0.0.1:18080/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'disabled', whisper_loaded: false, canvas_prompt_asr: false }) });
    });
    await context.route(`${origin}/api/**`, async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const packageId = packageIdFromPath(pathname);
      if (packageId) counters.packageIds.add(packageId);
      if (pathname === '/api/round-receipt/' + packageId) counters.receipt += 1;
      if (pathname.startsWith('/api/round-source-image/')) {
        counters.sourceImage += 1;
        if (behavior === 'upload-retry' && counters.sourceImage === 1) {
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'harness injected source upload failure' }) });
          return;
        }
      }
      if (pathname.startsWith('/api/round-audio/')) {
        counters.audio += 1;
        if (behavior === 'partial-media' && counters.audio === 1) {
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'harness injected audio upload failure' }) });
          return;
        }
      }
      if (pathname.startsWith('/api/round-trace-segment/')) counters.trace += 1;
      if (pathname === '/api/prompt-package') {
        counters.promptPackage += 1;
        if (request.postData()?.includes('resume_round')) counters.promptPackageResume += 1;
      }
      await route.continue();
    });
    const page = await context.newPage();
    if (behavior === 'response-lost') {
      await page.addInitScript(() => {
        // Keep the async audio finalization window open for the boundary check.
        const nativeStop = MediaRecorder.prototype.stop;
        MediaRecorder.prototype.stop = function () {
          setTimeout(() => nativeStop.call(this), 800);
        };
        let responseLost = false;
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
          const response = await nativeFetch(input, init);
          const requestBody = typeof init?.body === 'string' ? init.body : '';
          if (!responseLost && requestUrl.endsWith('/api/prompt-package') && !requestBody.includes('"resume_round":true')) {
            responseLost = true;
            await response.clone().arrayBuffer();
            throw new TypeError('harness injected browser response loss after successful POST');
          }
          return response;
        };
      });
    }
    const diagnostics = browserDiagnostics(page);
    debugPage = page;
    debugDiagnostics = diagnostics;
    await page.goto(origin);
    await page.locator('main.spike-shell').waitFor({ state: 'visible', timeout: 15_000 });
    const identity = await page.evaluate(async () => (await fetch('/api/runtime-identity', { cache: 'no-store' })).json());
    assert(identity.asr_enabled === false && identity.delivery_mode === 'local', `Round runtime identity is not ASR-disabled/local for ${mode}.`);
    await waitForStartButton(page);
    await page.getByRole('button', { name: '开始推演' }).click();
    await page.getByText('录音中', { exact: false }).waitFor({ state: 'visible', timeout: 15_000 });
    await drawSyntheticLine(page);
    await importSyntheticImage(page, imagePath);
    await drawSyntheticLine(page, 0.12);
    await page.waitForTimeout(500);

    const firstRetry = await finishAndWait(page, behavior === 'upload-retry' || behavior === 'partial-media' ? 'retry' : 'success', behavior === 'response-lost');
    const failedAttemptRequestCounts = behavior === 'upload-retry' || behavior === 'partial-media'
      ? { source_image: counters.sourceImage, audio: counters.audio, trace: counters.trace, prompt_package: counters.promptPackage }
      : null;
    if (behavior === 'upload-retry') {
      assert(counters.sourceImage === 1, `Injected upload failure did not hit exactly once (got ${counters.sourceImage}).`);
      await firstRetry.click();
      await page.getByRole('button', { name: '开始下一轮' }).waitFor({ state: 'visible', timeout: 60_000 });
    }
    if (behavior === 'partial-media') {
      assert(counters.sourceImage === 1 && counters.audio === 1 && counters.trace === 0 && counters.promptPackage === 0, `Partial media failure did not stop after the already-archived image: ${JSON.stringify(counters)}`);
      await firstRetry.click();
      await page.getByRole('button', { name: '开始下一轮' }).waitFor({ state: 'visible', timeout: 60_000 });
    }

    const firstPackageId = [...counters.packageIds][0];
    assert(firstPackageId, 'Round export did not expose a package identity through its protected API paths.');
    const first = await inspectRound({
      dataHome: sandbox.dataHome,
      projectDir: sandbox.projectDir,
      packageId: firstPackageId,
      imagePath,
      expectedSourceUpload: true,
      expectedAudioUpload: true,
    });

    const roundsAfterFirst = (await readdir(resolve(first.board, 'rounds'), { withFileTypes: true })).filter((entry) => entry.isDirectory());
    assert(roundsAfterFirst.length === 1, `First export created ${roundsAfterFirst.length} round directories.`);
    if (behavior === 'response-lost') {
      assert(!JSON.stringify(first.rawPackage).includes('late-after-finish'), 'An import after Finish contaminated the immutable round.');
      assert(counters.promptPackage === 2 && counters.promptPackageResume === 1, `Lost-response recovery did not use one initial POST plus one resume POST: ${JSON.stringify(counters)}`);
      assert(counters.sourceImage === 1 && counters.audio === 1 && counters.trace >= 1, `Lost-response recovery retransmitted media/trace: ${JSON.stringify(counters)}`);
    }
    if (behavior === 'upload-retry') {
      assert(counters.sourceImage === 2 && counters.audio === 1 && counters.promptPackage === 1, `Explicit upload retry duplicated the round or audio: ${JSON.stringify(counters)}`);
    }
    if (behavior === 'partial-media') {
      assert(counters.sourceImage === 2 && counters.audio === 2 && counters.trace === 1 && counters.promptPackage === 1, `Partial media retry did not preserve and resend the fixed round media: ${JSON.stringify(counters)}`);
    }
    const firstRoundRequestCounts = {
      receipt: counters.receipt,
      source_image: counters.sourceImage,
      audio: counters.audio,
      trace: counters.trace,
      prompt_package: counters.promptPackage,
      prompt_package_resume: counters.promptPackageResume,
    };

    await page.getByRole('button', { name: '开始下一轮' }).click();
    await page.getByText('录音中', { exact: false }).waitFor({ state: 'visible', timeout: 15_000 });
    await drawSyntheticLine(page, 0.18);
    await page.waitForTimeout(350);
    await finishAndWait(page, 'success');
    const latest = await readLatestPromptPackage({ dataHome: sandbox.dataHome, projectDir: sandbox.projectDir });
    const secondPackageId = latest.package?.meta?.package_id;
    assert(secondPackageId && secondPackageId !== firstPackageId, 'Next round reused the previous package identity.');
    const second = await inspectRound({
      dataHome: sandbox.dataHome,
      projectDir: sandbox.projectDir,
      packageId: secondPackageId,
      imagePath,
      expectedSourceUpload: false,
      expectedAudioUpload: true,
    });
    const allRounds = (await readdir(resolve(first.board, 'rounds'), { withFileTypes: true })).filter((entry) => entry.isDirectory());
    assert(allRounds.length === 2, `Next round isolation expected two immutable rounds, got ${allRounds.length}.`);
    assert(second.rawPackage.meta?.package_id === secondPackageId && first.rawPackage.meta?.package_id !== secondPackageId, 'Next round package contents crossed the first-round identity boundary.');
    assert(counters.packageIds.size >= 2, `Protected API requests did not expose two round identities: ${JSON.stringify(counters)}`);
    const relevantErrors = diagnostics.errors.filter((entry) => {
      if ((behavior === 'upload-retry' || behavior === 'partial-media') && entry.includes('status of 503')) return false;
      return true;
    });
    const relevantHttpErrors = diagnostics.httpErrors.filter((entry) => {
      if (entry.includes('http 404:') && entry.includes('/api/round-receipt/')) return false;
      if ((behavior === 'upload-retry' || behavior === 'partial-media') && entry.includes('http 503:') && (entry.includes('/api/round-source-image/') || entry.includes('/api/round-audio/'))) return false;
      return true;
    });
    assert(relevantErrors.length === 0 && relevantHttpErrors.length === 0, `Unexpected browser errors: ${[...relevantErrors, ...relevantHttpErrors].join(' | ')}`);
    return {
      ok: true,
      scenario: behavior,
      server: mode,
      origin,
      first_package_id: firstPackageId,
      second_package_id: secondPackageId,
      rounds: allRounds.length,
      compiler_ok: first.manifest.engine.ok === true && second.manifest.engine.ok === true,
      ...(behavior === 'response-lost' ? { end_boundary_frozen: true } : {}),
      mcp_latest_package_id: latest.package.meta.package_id,
      first_round_request_counts: firstRoundRequestCounts,
      ...(failedAttemptRequestCounts ? { failed_attempt_request_counts: failedAttemptRequestCounts } : {}),
      total_request_counts: {
        receipt: counters.receipt,
        source_image: counters.sourceImage,
        audio: counters.audio,
        trace: counters.trace,
        prompt_package: counters.promptPackage,
        prompt_package_resume: counters.promptPackageResume,
      },
      boundaries: {
        data_home: sandbox.dataHome,
        home_unchanged: true,
        asr_enabled: false,
        delivery_mode: 'local',
        no_real_ports: true,
      },
    };
  } catch (error) {
    const pageText = await debugPage?.locator('body').innerText().catch(() => '') || '';
    const diagnostics = debugDiagnostics ? [...debugDiagnostics.errors, ...debugDiagnostics.httpErrors] : [];
    throw new Error(`${error.message}\nPage text:\n${pageText.slice(-4_000)}\nRequest counters: ${JSON.stringify({ ...counters, packageIds: [...counters.packageIds] })}\nBrowser diagnostics: ${diagnostics.join(' | ')}\nVite tail:\n${server.getLog()}`);
  } finally {
    await browser?.close().catch(() => undefined);
    await stopChild(server.child);
    await removeSandbox(sandbox.sandbox);
  }
}

async function runScenario(scenario, mode) {
  if (scenario === 'smoke') return runSmoke({ mode });
  return runRound({ mode, behavior: scenario === 'recovery' ? 'response-lost' : scenario === 'media-partial' ? 'partial-media' : 'upload-retry' });
}

async function main() {
  const scenario = scenarioFromArgs();
  const server = serverFromArgs();
  if (scenario === 'all') {
    const results = [];
    for (const mode of allowedServers('dev')) {
      results.push(await runScenario('recovery', mode));
      results.push(await runScenario('upload-retry', mode));
      results.push(await runScenario('media-partial', mode));
      results.push(await runScenario('smoke', mode));
    }
    if (allowedServers(server).includes('preview')) {
      await ensureAppBuild();
      results.push(await runScenario('smoke', 'preview'));
    }
    process.stdout.write(`${JSON.stringify({ ok: true, scenarios: results }, null, 2)}\n`);
    return;
  }
  if (server === 'preview' || server === 'both') await ensureAppBuild();
  const results = [];
  for (const mode of allowedServers(server)) results.push(await runScenario(scenario, mode));
  process.stdout.write(`${JSON.stringify({ ok: true, scenarios: results }, null, 2)}\n`);
}

await main();
