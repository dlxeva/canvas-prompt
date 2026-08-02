#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const root = resolve(import.meta.dirname, '..');
const bundledPlaywrightModule = resolve(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright');
const playwrightModule = process.env.CANVAS_PROMPT_PLAYWRIGHT_MODULE ?? (existsSync(bundledPlaywrightModule) ? bundledPlaywrightModule : null);
const chromePath = process.env.CANVAS_PROMPT_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    if (!playwrightModule) throw new Error(`Playwright is unavailable. Set CANVAS_PROMPT_PLAYWRIGHT_MODULE to its package directory. ${error.message}`);
    return import(pathToFileURL(resolve(playwrightModule, 'index.mjs')).href);
  }
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  if (!port) throw new Error('Unable to allocate a local test port.');
  return port;
}

function stream(content) {
  return `<< /Length ${Buffer.byteLength(content, 'binary')} >>\nstream\n${content}\nendstream`;
}

function twoPagePdf() {
  const pageOne = 'BT /F1 24 Tf 72 700 Td (Canvas Prompt Page One) Tj ET';
  const pageTwo = 'BT /F1 24 Tf 72 700 Td (Canvas Prompt Page Two) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    stream(pageOne),
    stream(pageTwo),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

function scenarioFromArgs() {
  const index = process.argv.indexOf('--scenario');
  const scenario = index === -1 ? 'handoff' : process.argv[index + 1];
  if (!['entry', 'handoff', 'visual-failure'].includes(scenario)) {
    throw new Error(`Unknown scenario: ${scenario ?? '(missing)'}`);
  }
  return scenario;
}

async function waitForHttp(url, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited before becoming ready (${child.exitCode}).`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Expected while Vite is starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function stopChild(child) {
  if (child.exitCode !== null) return Promise.resolve();
  child.kill('SIGTERM');
  return new Promise((resolveStop) => {
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3_000);
    child.once('exit', () => { clearTimeout(timer); resolveStop(); });
  });
}

async function readPageThroughMcp(home, packageId, pageId) {
  const code = `
    import { createHash } from 'node:crypto';
    const server = await import('./mcp/server.mjs?browser-harness=' + Date.now());
    const result = await server.handleGetArtifactReviewPageVisual(${JSON.stringify({ package_id: packageId, page_id: pageId })});
    if (result.isError) throw new Error(result.content[0].text);
    const image = result.content.find((item) => item.type === 'image');
    const bytes = Buffer.from(image.data, 'base64');
    process.stdout.write(JSON.stringify({ types: result.content.map((item) => item.type), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: root,
    env: { ...process.env, HOME: home, CANVAS_PROMPT_MCP_TEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolveExit) => child.once('exit', resolveExit));
  if (exitCode !== 0) throw new Error(`MCP page read failed: ${stderr || stdout}`);
  return JSON.parse(stdout);
}

async function readLatestThroughMcp(home) {
  const code = `
    const server = await import('./mcp/server.mjs?browser-harness-latest=' + Date.now());
    const result = await server.handleGetLatestArtifactReview();
    if (result.isError) throw new Error(result.content[0].text);
    process.stdout.write(result.content[0].text);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: root,
    env: { ...process.env, HOME: home, CANVAS_PROMPT_MCP_TEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolveExit) => child.once('exit', resolveExit));
  if (exitCode !== 0) throw new Error(`MCP latest read failed: ${stderr || stdout}`);
  return JSON.parse(stdout);
}

async function main() {
  const scenario = scenarioFromArgs();
  const sandbox = await mkdtemp(resolve(tmpdir(), 'canvas-prompt-artifact-browser-'));
  const home = resolve(sandbox, 'home');
  const project = resolve(sandbox, 'project');
  const pdfPath = resolve(project, 'runtime-evidence.pdf');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(pdfPath, twoPagePdf());
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const vite = spawn('npm', ['--prefix', 'app', 'run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: root,
    env: { ...process.env, HOME: home, CANVAS_PROMPT_PROJECT_DIR: project, CANVAS_PROMPT_ASR_URL: 'http://127.0.0.1:18080' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let viteLog = '';
  vite.stdout.on('data', (chunk) => { viteLog = `${viteLog}${chunk}`.slice(-8_000); });
  vite.stderr.on('data', (chunk) => { viteLog = `${viteLog}${chunk}`.slice(-8_000); });
  let browser;
  try {
    await waitForHttp(`${origin}/?artifact-review-spike=1`, vite);
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    const context = await browser.newContext({ permissions: ['microphone'] });
    await context.route('http://127.0.0.1:18080/**', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': '*' } });
        return;
      }
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': origin },
          body: JSON.stringify({ status: 'ok', whisper_loaded: true, canvas_prompt_asr: true }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': origin },
        body: JSON.stringify({ text: '这里需要调整', language: 'zh', duration: 0.4, segments: [{ start: 0, end: 0.4, text: '这里需要调整', confidence: 0.99 }] }),
      });
    });
    if (scenario === 'visual-failure') {
      await context.route(`${origin}/api/artifact-review-visual-evidence`, (route) => route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: '测试注入的视觉归档失败' }),
      }));
    }
    const page = await context.newPage();
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (scenario === 'visual-failure' && message.text().includes('status of 500')) return;
      browserErrors.push(`console: ${message.text()}`);
    });
    if (scenario === 'entry') {
      await page.goto(origin);
      const startFreeform = page.getByRole('button', { name: '开始推演' });
      await startFreeform.waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForFunction(() => {
        const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('开始推演'));
        return button instanceof HTMLButtonElement && !button.disabled;
      });
      await startFreeform.click();
      await page.getByText('录音中', { exact: false }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByRole('button', { name: '交互审阅' }).click();
      await page.getByRole('alert').filter({ hasText: '当前自由推演仍在记录或整理' }).waitFor({ state: 'visible' });
      if (page.url() !== `${origin}/`) throw new Error(`An active freeform round escaped its capture workspace: ${page.url()}`);
      await page.getByRole('button', { name: '结束推演' }).click();
      await page.getByRole('button', { name: '开始下一轮' }).waitFor({ state: 'visible', timeout: 30_000 });
      await page.getByRole('button', { name: '交互审阅' }).click();
      await page.getByRole('heading', { name: '交互审阅' }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByText('已切换到交互审阅', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.locator('.artifact-review-shell input[type=file]').setInputFiles(pdfPath);
      await page.locator('canvas[aria-label="PDF 第 1 页"]').waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByRole('button', { name: '自由推演' }).click();
      await page.getByRole('button', { name: '交互审阅' }).click();
      await page.locator('canvas[aria-label="PDF 第 1 页"]').waitFor({ state: 'visible', timeout: 15_000 });
      const pageJump = page.getByRole('combobox', { name: '快速跳转页面' });
      if (await pageJump.count() !== 1) throw new Error('Compact page jump control is missing from the review toolbar.');
      const zoomIn = page.getByRole('button', { name: '放大' });
      if (await zoomIn.count() !== 1) throw new Error('Zoom controls are missing from the review toolbar.');
      const missingTitles = await page.evaluate(() => Array.from(document.querySelectorAll('.artifact-review-shell button')).filter((button) => !button.title).map((button) => button.getAttribute('aria-label') || button.textContent?.trim() || '(unnamed)'));
      if (missingTitles.length > 0) throw new Error(`Review buttons missing title: ${missingTitles.join(', ')}`);
      await page.getByRole('button', { name: 'Switch to English' }).click();
      await page.getByRole('button', { name: 'Start review' }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByRole('button', { name: '切换至中文' }).click();
      await page.locator('summary[aria-label="更多审阅操作"]').click();
      await page.getByRole('button', { name: '关闭当前文件' }).click();
      await page.getByRole('button', { name: '选择本地 PDF / PPTX' }).waitFor({ state: 'visible', timeout: 15_000 });
      if (!page.url().endsWith('?artifact-review-spike=1')) throw new Error(`Unified entry did not preserve the review route: ${page.url()}`);
      if (browserErrors.length > 0) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`);
      process.stdout.write(`${JSON.stringify({ ok: true, scenario, route: page.url(), heading: '交互审阅' }, null, 2)}\n`);
      return;
    }

    await page.goto(`${origin}/?artifact-review-spike=1`);
    await page.locator('.artifact-review-shell input[type=file]').setInputFiles(pdfPath);
    await page.locator('canvas[aria-label="PDF 第 1 页"]').waitFor({ state: 'visible', timeout: 15_000 });
    const previousEdge = page.getByRole('button', { name: '页面左侧：上一页' });
    const nextEdge = page.getByRole('button', { name: '页面右侧：下一页' });
    await previousEdge.waitFor({ state: 'visible' });
    await nextEdge.waitFor({ state: 'visible' });
    if (!(await previousEdge.isDisabled()) || await nextEdge.isDisabled()) {
      throw new Error('Page-edge controls do not expose the expected first-page boundary.');
    }
    await nextEdge.click();
    await page.locator('canvas[aria-label="PDF 第 2 页"]').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction(() => {
      const previous = document.querySelector('button[aria-label="页面左侧：上一页"]');
      const next = document.querySelector('button[aria-label="页面右侧：下一页"]');
      return previous instanceof HTMLButtonElement && !previous.disabled
        && next instanceof HTMLButtonElement && next.disabled;
    });
    await page.getByRole('button', { name: '圈选' }).click();
    await page.getByRole('button', { name: '开始审阅' }).click();
    await page.getByText('审阅中', { exact: true }).waitFor();
    await page.getByRole('button', { name: '自由推演' }).click();
    await page.getByRole('alert').filter({ hasText: '当前交互审阅仍在记录或整理' }).waitFor({ state: 'visible' });
    if (!page.url().endsWith('?artifact-review-spike=1')) {
      throw new Error(`An active review escaped its capture workspace: ${page.url()}`);
    }
    const reviewStillVisible = await page.locator('main.artifact-review-shell').isVisible();
    if (!reviewStillVisible) throw new Error('The capture gate warned but still hid the active review workspace.');
    const overlay = page.locator('svg[aria-label="PDF 第 2 页批注层"]');
    const box = await overlay.boundingBox();
    if (!box) throw new Error('Artifact Review annotation overlay is not visible.');
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(450);
    await page.getByRole('button', { name: '结束审阅' }).click();
    if (await page.getByText('候选确认', { exact: true }).count() !== 0) {
      throw new Error('The review player exposed low-level evidence binding confirmation.');
    }
    if (scenario === 'visual-failure') {
      await page.getByText(/本轮交互审阅已保存，但页面视觉证据未能归档/).waitFor({ timeout: 20_000 });
    } else {
      await page.getByText(/已归档 1 页视觉证据/).waitFor({ timeout: 20_000 });
    }
    await page.getByRole('button', { name: '自由推演' }).click();
    await page.locator('main.spike-shell').waitFor({ state: 'visible', timeout: 15_000 });
    if (page.url() !== `${origin}/`) throw new Error(`A completed review could not return to Freeform: ${page.url()}`);
    if (browserErrors.length > 0) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`);

    const board = resolve(home, '.canvas-prompt', 'board');
    const latest = JSON.parse(await readFile(resolve(board, 'latest-artifact-review-package.json'), 'utf8'));
    if (latest.pages.length !== 2 || !latest.page_visits.some((visit) => visit.page_number === 2)) {
      throw new Error('Page-edge navigation did not preserve the two-page artifact identity and page visit.');
    }
    const reviewedPage = latest.pages[1];
    if (latest.annotations.length !== 1 || latest.annotations[0].page_id !== reviewedPage.page_id) {
      throw new Error('The page-2 annotation is not bound to the immutable page-2 identity.');
    }
    if (latest.review_state.execution_authorized !== false) throw new Error('Artifact Review unexpectedly authorized execution.');
    if (existsSync(resolve(board, 'latest-artifact-review-confirmation-ledger.json'))) {
      throw new Error('A new review unexpectedly created a low-level confirmation sidecar.');
    }
    const latestMcp = await readLatestThroughMcp(home);
    if (latestMcp.package.package_id !== latest.package_id || latestMcp.package.review_state.execution_authorized !== false) {
      throw new Error('MCP latest review does not match the structured package.');
    }
    if (
      latestMcp.review_brief.execution_gate?.status !== 'awaiting_user_confirmation'
      || latestMcp.review_brief.execution_gate?.confirmation_channel !== 'conversation'
      || latestMcp.review_brief.execution_gate?.user_visible_internal_ids !== false
    ) throw new Error('MCP latest review does not expose the conversation confirmation gate.');

    if (scenario === 'visual-failure') {
      if (latestMcp.visual_evidence.availability !== 'not_archived') throw new Error('MCP did not expose visual evidence degradation.');
      if (existsSync(resolve(board, 'artifact-review-rounds', latest.package_id, 'visual-evidence'))) {
        throw new Error('Visual evidence files remained after the injected archive failure.');
      }
      process.stdout.write(`${JSON.stringify({
        ok: true,
        scenario,
        package_id: latest.package_id,
        page_id: reviewedPage.page_id,
        page_count: latest.pages.length,
        page_visits: latest.page_visits.map((visit) => visit.page_number),
        confirmation_channel: latestMcp.review_brief.execution_gate.confirmation_channel,
        visual_availability: latestMcp.visual_evidence.availability,
        execution_authorized: latest.review_state.execution_authorized,
      }, null, 2)}\n`);
      return;
    }
    const visualDir = resolve(board, 'artifact-review-rounds', latest.package_id, 'visual-evidence');
    const manifest = JSON.parse(await readFile(resolve(visualDir, 'manifest.json'), 'utf8'));
    if (manifest.package_id !== latest.package_id || manifest.pages.length !== 1 || manifest.pages[0].page_id !== reviewedPage.page_id) {
      throw new Error('Archived visual evidence identity does not match the immutable package.');
    }
    const pngPath = resolve(visualDir, `${manifest.pages[0].render_ref}.png`);
    const pngBytes = await readFile(pngPath);
    const pngSha = createHash('sha256').update(pngBytes).digest('hex');
    if (pngSha !== manifest.pages[0].sha256 || pngBytes.length !== manifest.pages[0].byte_length) throw new Error('Archived PNG does not match its manifest.');
    const mcp = await readPageThroughMcp(home, latest.package_id, reviewedPage.page_id);
    if (mcp.sha256 !== pngSha || mcp.bytes !== pngBytes.length || mcp.types.join(',') !== 'text,image') throw new Error('MCP page result does not match the archived PNG.');

    process.stdout.write(`${JSON.stringify({
      ok: true,
      scenario,
      package_id: latest.package_id,
      page_id: reviewedPage.page_id,
      page_count: latest.pages.length,
      page_visits: latest.page_visits.map((visit) => visit.page_number),
      annotations: latest.annotations.length,
      voice_segments: latest.voice_segments.length,
      confirmation_channel: latestMcp.review_brief.execution_gate.confirmation_channel,
      visual_bytes: pngBytes.length,
      visual_sha256: pngSha,
      mcp_content_types: mcp.types,
      execution_authorized: latest.review_state.execution_authorized,
    }, null, 2)}\n`);
  } catch (error) {
    throw new Error(`${error.message}\nVite tail:\n${viteLog}`);
  } finally {
    await browser?.close().catch(() => undefined);
    await stopChild(vite);
    await rm(sandbox, { recursive: true, force: true });
  }
}

await main();
