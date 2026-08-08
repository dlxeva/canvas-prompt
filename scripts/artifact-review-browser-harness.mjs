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

function pdfWithPageSizes(pages) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${index + 3} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    ...pages.map((page, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 ${pages.length + 5} 0 R >> >> /Contents ${pages.length + 3 + index} 0 R >>`),
    ...pages.map((page) => stream(`BT /F1 24 Tf 72 ${Math.max(72, page.height - 92)} Td (${page.label}) Tj ET`)),
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

function pdfWithPages(pageWidth, pageHeight, labels) {
  return pdfWithPageSizes(labels.map((label) => ({ label, width: pageWidth, height: pageHeight })));
}

function twoPagePdf() {
  return pdfWithPages(612, 792, ['Canvas Prompt Page One', 'Canvas Prompt Page Two']);
}

function responsiveReviewPdf() {
  return pdfWithPageSizes([
    { label: 'Canvas Prompt Widescreen Page', width: 960, height: 540 },
    { label: 'Canvas Prompt Portrait Page', width: 600, height: 900 },
  ]);
}

function scenarioFromArgs() {
  const index = process.argv.indexOf('--scenario');
  const scenario = index === -1 ? 'handoff' : process.argv[index + 1];
  if (!['entry', 'handoff', 'visual-failure', 'responsive'].includes(scenario)) {
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
  await writeFile(pdfPath, scenario === 'responsive' ? responsiveReviewPdf() : twoPagePdf());
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
    const context = await browser.newContext({ permissions: ['microphone'], viewport: scenario === 'responsive' ? { width: 1600, height: 1000 } : { width: 1280, height: 720 } });
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
      process.stdout.write(`${JSON.stringify({ ok: true, scenario, isolated_origin: origin, route: page.url(), heading: '交互审阅' }, null, 2)}\n`);
      return;
    }

    await page.goto(`${origin}/?artifact-review-spike=1`);
    await page.locator('.artifact-review-shell input[type=file]').setInputFiles(pdfPath);
    await page.locator('canvas[aria-label="PDF 第 1 页"]').waitFor({ state: 'visible', timeout: 15_000 });
    if (scenario === 'responsive') {
      const measure = () => page.evaluate(() => {
        const stage = document.querySelector('.artifact-review-stage-scroll');
        const stageShell = document.querySelector('.artifact-review-stage-shell');
        const canvas = document.querySelector('canvas[aria-label^="PDF 第"]');
        const overlay = document.querySelector('svg[aria-label$="批注层"]');
        const previous = document.querySelector('button[aria-label="页面左侧：上一页"]');
        const next = document.querySelector('button[aria-label="页面右侧：下一页"]');
        const pageBounds = canvas?.getBoundingClientRect();
        const stageBounds = stage?.getBoundingClientRect();
        const stageShellBounds = stageShell?.getBoundingClientRect();
        const previousBounds = previous?.getBoundingClientRect();
        const nextBounds = next?.getBoundingClientRect();
        const visiblePageTop = pageBounds && stageBounds ? Math.max(pageBounds.top, stageBounds.top) : null;
        const visiblePageBottom = pageBounds && stageBounds ? Math.min(pageBounds.bottom, stageBounds.bottom) : null;
        const visiblePageLeft = pageBounds && stageBounds ? Math.max(pageBounds.left, stageBounds.left) : null;
        const visiblePageRight = pageBounds && stageBounds ? Math.min(pageBounds.right, stageBounds.right) : null;
        const pageVisibleCenterY = visiblePageTop !== null && visiblePageBottom !== null && visiblePageBottom > visiblePageTop ? (visiblePageTop + visiblePageBottom) / 2 : null;
        const buttonCenters = previousBounds && nextBounds ? {
          previousY: previousBounds.top + previousBounds.height / 2,
          nextY: nextBounds.top + nextBounds.height / 2,
        } : null;
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          stage: stageBounds ? { width: stageBounds.width, height: stageBounds.height, clientWidth: stage.clientWidth, clientHeight: stage.clientHeight, scrollWidth: stage.scrollWidth, scrollHeight: stage.scrollHeight } : null,
          stageShell: stageShellBounds ? { width: stageShellBounds.width, height: stageShellBounds.height } : null,
          canvas: pageBounds ? { x: pageBounds.x, y: pageBounds.y, width: pageBounds.width, height: pageBounds.height, ratio: pageBounds.width / pageBounds.height } : null,
          stageGaps: pageBounds && stageShellBounds ? { top: pageBounds.top - stageShellBounds.top, bottom: stageShellBounds.bottom - pageBounds.bottom, left: pageBounds.left - stageShellBounds.left, right: stageShellBounds.right - pageBounds.right } : null,
          overlay: overlay ? { x: overlay.getBoundingClientRect().x, y: overlay.getBoundingClientRect().y, width: overlay.getBoundingClientRect().width, height: overlay.getBoundingClientRect().height } : null,
          pageVisibleBounds: visiblePageTop !== null && visiblePageBottom !== null && visiblePageLeft !== null && visiblePageRight !== null ? { top: visiblePageTop, bottom: visiblePageBottom, left: visiblePageLeft, right: visiblePageRight } : null,
          pageVisibleCenterY,
          navigation: previousBounds && nextBounds && buttonCenters ? {
            previous: { x: previousBounds.x, y: previousBounds.y, width: previousBounds.width, height: previousBounds.height },
            next: { x: nextBounds.x, y: nextBounds.y, width: nextBounds.width, height: nextBounds.height },
            centerDeviation: pageVisibleCenterY === null ? null : Math.max(Math.abs(buttonCenters.previousY - pageVisibleCenterY), Math.abs(buttonCenters.nextY - pageVisibleCenterY)),
            previousGap: pageBounds ? pageBounds.left - previousBounds.right : null,
            nextGap: pageBounds ? nextBounds.left - pageBounds.right : null,
            mode: window.matchMedia('(max-width: 700px)').matches ? 'bottom' : 'page-edge',
          } : null,
          zoom: document.querySelector('.artifact-review-zoom span')?.textContent,
          documentScrollWidth: document.documentElement.scrollWidth,
        };
      });
      const wideDefault = await measure();
      if (!wideDefault.canvas || !wideDefault.overlay || !wideDefault.stage || wideDefault.canvas.width <= 960 || wideDefault.canvas.height <= 540) throw new Error(`Wide viewport did not fit the page to the available stage: ${JSON.stringify(wideDefault)}`);
      if (Math.abs(wideDefault.canvas.width - wideDefault.overlay.width) > 1 || Math.abs(wideDefault.canvas.height - wideDefault.overlay.height) > 1) throw new Error(`Canvas and annotation overlay diverged at wide size: ${JSON.stringify(wideDefault)}`);
      if (Math.abs(wideDefault.canvas.ratio - 16 / 9) > 0.01 || wideDefault.navigation?.mode !== 'page-edge' || (wideDefault.navigation?.centerDeviation ?? Infinity) > 4 || (wideDefault.navigation?.previousGap ?? -Infinity) < 4 || (wideDefault.navigation?.nextGap ?? -Infinity) < 4) throw new Error(`Wide page-edge controls are not bound to the rendered page: ${JSON.stringify(wideDefault)}`);
      await page.setViewportSize({ width: 1371, height: 1166 });
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas[aria-label="PDF 第 1 页"]');
        return canvas instanceof HTMLCanvasElement && canvas.getBoundingClientRect().width > 1100;
      });
      const highDefault = await measure();
      if (!highDefault.canvas || !highDefault.stage || !highDefault.stageShell || !highDefault.stageGaps || highDefault.canvas.width <= 1100 || highDefault.stageGaps.bottom > 100) throw new Error(`High viewport kept excessive stage whitespace: ${JSON.stringify(highDefault)}`);
      if (Math.abs(highDefault.canvas.ratio - 16 / 9) > 0.01 || !highDefault.overlay || Math.abs(highDefault.canvas.width - highDefault.overlay.width) > 1 || Math.abs(highDefault.canvas.height - highDefault.overlay.height) > 1) throw new Error(`High viewport changed the page ratio or overlay geometry: ${JSON.stringify(highDefault)}`);
      if (highDefault.navigation?.mode !== 'page-edge' || (highDefault.navigation?.centerDeviation ?? Infinity) > 4 || (highDefault.navigation?.previousGap ?? -Infinity) < 4 || (highDefault.navigation?.nextGap ?? -Infinity) < 4) throw new Error(`High viewport page-edge controls drifted into stage whitespace: ${JSON.stringify(highDefault)}`);
      await page.setViewportSize({ width: 640, height: 800 });
      await page.waitForFunction((previousWidth) => {
        const canvas = document.querySelector('canvas[aria-label="PDF 第 1 页"]');
        return canvas instanceof HTMLCanvasElement && canvas.getBoundingClientRect().width < previousWidth - 50;
      }, highDefault.canvas.width);
      const narrowDefault = await measure();
      if (!narrowDefault.canvas || !narrowDefault.overlay || narrowDefault.canvas.width >= highDefault.canvas.width) throw new Error(`Narrow resize did not reduce the page: ${JSON.stringify({ highDefault, narrowDefault })}`);
      if (narrowDefault.documentScrollWidth > narrowDefault.viewport.width + 1) throw new Error(`Narrow review introduced page-level horizontal overflow: ${JSON.stringify(narrowDefault)}`);
      if (Math.abs(narrowDefault.canvas.width - narrowDefault.overlay.width) > 1 || Math.abs(narrowDefault.canvas.height - narrowDefault.overlay.height) > 1) throw new Error(`Canvas and annotation overlay diverged at narrow size: ${JSON.stringify(narrowDefault)}`);
      if (narrowDefault.navigation?.mode !== 'bottom') throw new Error(`Narrow review lost the bottom navigation fallback: ${JSON.stringify(narrowDefault)}`);
      await page.getByRole('button', { name: '圈选' }).click();
      const narrowOverlay = page.locator('svg[aria-label="PDF 第 1 页批注层"]');
      const narrowBox = await narrowOverlay.boundingBox();
      if (!narrowBox) throw new Error('Responsive annotation overlay is not visible.');
      await page.mouse.move(narrowBox.x + narrowBox.width * 0.2, narrowBox.y + narrowBox.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(narrowBox.x + narrowBox.width * 0.55, narrowBox.y + narrowBox.height * 0.45, { steps: 5 });
      await page.mouse.up();
      await page.locator('svg[aria-label="PDF 第 1 页批注层"] ellipse').waitFor({ state: 'visible' });
      const narrowEllipse = await page.locator('svg[aria-label="PDF 第 1 页批注层"] ellipse').boundingBox();
      await page.getByRole('button', { name: '放大' }).click();
      await page.waitForFunction(() => document.querySelector('.artifact-review-zoom span')?.textContent === '120%');
      const narrowManual = await measure();
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.waitForFunction((previousWidth) => {
        const canvas = document.querySelector('canvas[aria-label="PDF 第 1 页"]');
        return canvas instanceof HTMLCanvasElement && canvas.getBoundingClientRect().width > previousWidth + 50;
      }, narrowManual.canvas.width);
      const wideManual = await measure();
      if (wideManual.zoom !== '120%') throw new Error(`Resize reset explicit zoom: ${JSON.stringify({ narrowManual, wideManual })}`);
      if (!wideManual.canvas || wideManual.canvas.width <= highDefault.canvas.width) throw new Error(`Manual zoom was not preserved after resize: ${JSON.stringify({ highDefault, wideManual })}`);
      if (!wideManual.overlay || Math.abs(wideManual.canvas.width - wideManual.overlay.width) > 1 || Math.abs(wideManual.canvas.height - wideManual.overlay.height) > 1) throw new Error(`Canvas and annotation overlay diverged after resize: ${JSON.stringify(wideManual)}`);
      if (wideManual.navigation?.mode !== 'page-edge' || (wideManual.navigation?.centerDeviation ?? Infinity) > 4) throw new Error(`120% page-edge controls drifted after resize: ${JSON.stringify(wideManual)}`);
      const wideEllipse = await page.locator('svg[aria-label="PDF 第 1 页批注层"] ellipse').boundingBox();
      const wideOverlayBox = await narrowOverlay.boundingBox();
      if (!narrowEllipse || !wideEllipse || !wideOverlayBox || Math.abs((narrowEllipse.x + narrowEllipse.width / 2 - narrowBox.x) / narrowBox.width - (wideEllipse.x + wideEllipse.width / 2 - wideOverlayBox.x) / wideOverlayBox.width) > 0.05 || Math.abs((narrowEllipse.y + narrowEllipse.height / 2 - narrowBox.y) / narrowBox.height - (wideEllipse.y + wideEllipse.height / 2 - wideOverlayBox.y) / wideOverlayBox.height) > 0.05) throw new Error('Annotation geometry drifted across resize.');
      await page.getByRole('button', { name: '页面右侧：下一页' }).click();
      await page.locator('canvas[aria-label="PDF 第 2 页"]').waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas[aria-label="PDF 第 2 页"]');
        const previous = document.querySelector('button[aria-label="页面左侧：上一页"]');
        return canvas instanceof HTMLCanvasElement && previous instanceof HTMLButtonElement && canvas.getBoundingClientRect().height > 800 && getComputedStyle(previous).top !== 'auto';
      });
      const portraitManual = await measure();
      if (!portraitManual.canvas || Math.abs(portraitManual.canvas.ratio - 2 / 3) > 0.01 || !portraitManual.overlay || Math.abs(portraitManual.canvas.width - portraitManual.overlay.width) > 1 || Math.abs(portraitManual.canvas.height - portraitManual.overlay.height) > 1) throw new Error(`Portrait page was stretched or lost overlay alignment: ${JSON.stringify(portraitManual)}`);
      if (portraitManual.navigation?.mode !== 'page-edge' || (portraitManual.navigation?.centerDeviation ?? Infinity) > 4) throw new Error(`Portrait page-edge controls drifted under 120% zoom: ${JSON.stringify(portraitManual)}`);
      await page.evaluate(() => {
        const stage = document.querySelector('.artifact-review-stage-scroll');
        if (stage instanceof HTMLElement) stage.scrollTop = stage.scrollHeight;
      });
      await page.waitForFunction(() => {
        const stage = document.querySelector('.artifact-review-stage-scroll');
        const canvas = document.querySelector('canvas[aria-label="PDF 第 2 页"]');
        const previous = document.querySelector('button[aria-label="页面左侧：上一页"]');
        const next = document.querySelector('button[aria-label="页面右侧：下一页"]');
        if (!(stage instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement) || !(previous instanceof HTMLButtonElement) || !(next instanceof HTMLButtonElement) || stage.scrollTop <= 0) return false;
        const stageBounds = stage.getBoundingClientRect();
        const pageBounds = canvas.getBoundingClientRect();
        const visibleTop = Math.max(stageBounds.top, pageBounds.top);
        const visibleBottom = Math.min(stageBounds.bottom, pageBounds.bottom);
        if (visibleBottom <= visibleTop) return false;
        const visibleCenter = (visibleTop + visibleBottom) / 2;
        const previousCenter = previous.getBoundingClientRect().top + previous.getBoundingClientRect().height / 2;
        const nextCenter = next.getBoundingClientRect().top + next.getBoundingClientRect().height / 2;
        return Math.max(Math.abs(previousCenter - visibleCenter), Math.abs(nextCenter - visibleCenter)) <= 4;
      });
      const portraitScrolled = await measure();
      if ((portraitScrolled.navigation?.centerDeviation ?? Infinity) > 4 || Math.abs((portraitScrolled.pageVisibleCenterY ?? 0) - (portraitManual.pageVisibleCenterY ?? 0)) < 20) throw new Error(`Navigation did not follow the visible portion of an internally scrolled portrait page: ${JSON.stringify({ portraitManual, portraitScrolled })}`);
      if (browserErrors.length > 0) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`);
      process.stdout.write(`${JSON.stringify({ ok: true, scenario, isolated_origin: origin, wideDefault, highDefault, narrowDefault, narrowManual, wideManual, portraitManual, portraitScrolled, annotation_aligned: true, thresholds: { highStageBottomGapMax: 100, pageEdgeCenterDeviationMax: 4, overlayAlignmentMax: 1 } }, null, 2)}\n`);
      return;
    }
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
        isolated_origin: origin,
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
      isolated_origin: origin,
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
