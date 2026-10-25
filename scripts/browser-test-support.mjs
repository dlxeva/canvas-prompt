import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

export const root = resolve(import.meta.dirname, '..');
const bundledPlaywrightModule = resolve(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright');
const playwrightModule = process.env.CANVAS_PROMPT_PLAYWRIGHT_MODULE ?? (existsSync(bundledPlaywrightModule) ? bundledPlaywrightModule : null);
export const chromePath = process.env.CANVAS_PROMPT_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const viteBinary = resolve(root, 'app', 'node_modules', '.bin', 'vite');

export async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    if (!playwrightModule) throw new Error(`Playwright is unavailable. Set CANVAS_PROMPT_PLAYWRIGHT_MODULE to its package directory. ${error.message}`);
    return import(pathToFileURL(resolve(playwrightModule, 'index.mjs')).href);
  }
}

export async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  if (!port) throw new Error('Unable to allocate a local test port.');
  return port;
}

export async function createSandbox(prefix) {
  const sandbox = await mkdtemp(resolve(tmpdir(), prefix));
  const dataHome = resolve(sandbox, 'data-home');
  const projectDir = resolve(sandbox, 'project');
  await mkdir(dataHome, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  return { sandbox, dataHome, projectDir };
}

export function harnessEnv({ dataHome, projectDir, extra = {} }) {
  return {
    ...process.env,
    CANVAS_PROMPT_DATA_HOME: dataHome,
    CANVAS_PROMPT_PROJECT_DIR: projectDir,
    CANVAS_PROMPT_ASR: 'disabled',
    CANVAS_PROMPT_DELIVERY_MODE: 'local',
    ...extra,
  };
}

export function startVite({ mode = 'dev', port, dataHome, projectDir, extraEnv = {} }) {
  const args = mode === 'preview'
    ? ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
    : ['--host', '127.0.0.1', '--port', String(port), '--strictPort'];
  const child = spawn(viteBinary, args, {
    cwd: resolve(root, 'app'),
    env: harnessEnv({ dataHome, projectDir, extra: extraEnv }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log = `${log}${chunk}`.slice(-12_000); });
  child.stderr.on('data', (chunk) => { log = `${log}${chunk}`.slice(-12_000); });
  return { child, getLog: () => log };
}

export async function ensureAppBuild() {
  const child = spawn('npm', ['--prefix', 'app', 'run', 'build'], {
    cwd: root,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_000); });
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_000); });
  const exitCode = await new Promise((resolveExit) => child.once('exit', resolveExit));
  if (exitCode !== 0) throw new Error(`App build failed with exit ${exitCode}.\n${output}`);
  return output;
}

export async function waitForHttp(url, child, timeoutMs = 20_000) {
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

export function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  child.kill('SIGTERM');
  return new Promise((resolveStop) => {
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3_000);
    child.once('exit', () => { clearTimeout(timer); resolveStop(); });
  });
}

export function browserDiagnostics(page) {
  const errors = [];
  const httpErrors = [];
  const isExpectedMissingAsset = (url) => {
    try {
      const pathname = new URL(url).pathname;
      return pathname === '/favicon.ico' || pathname === '/robots.txt';
    } catch {
      return false;
    }
  };
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400 && !isExpectedMissingAsset(response.url())) {
      httpErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Chromium logs the missing favicon as a generic console error without its URL.
    if (message.text().includes('Failed to load resource: the server responded with a status of 404')) return;
    errors.push(`console: ${message.text()}`);
  });
  return {
    errors,
    httpErrors,
    assertClean() {
      if (errors.length > 0 || httpErrors.length > 0) {
        throw new Error(`Browser errors: ${[...errors, ...httpErrors].join(' | ')}`);
      }
    },
  };
}

export async function writeFakeWav(path, { seconds = 0.25, sampleRate = 8_000 } = {}) {
  const sampleCount = Math.max(1, Math.round(seconds * sampleRate));
  const dataBytes = sampleCount * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  const samples = Buffer.alloc(dataBytes);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(Math.sin(index / 12) * 8_000);
    samples.writeInt16LE(value, index * 2);
  }
  await writeFile(path, Buffer.concat([header, samples]));
}

export async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function waitForFile(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await stat(path);
      if (info.isFile()) return info;
    } catch {
      // Expected while the round is compiling.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function callMcp({ dataHome, projectDir, handler, args = {}, label }) {
  const code = `
    const server = await import('./mcp/server.mjs?browser-harness=${Date.now()}');
    const result = await server[${JSON.stringify(handler)}](${JSON.stringify(args)});
    if (result.isError) throw new Error(result.content?.[0]?.text || 'MCP tool failed');
    process.stdout.write(result.content?.[0]?.text || '');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: root,
    env: harnessEnv({ dataHome, projectDir, extra: { CANVAS_PROMPT_MCP_TEST: '1' } }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolveExit) => child.once('exit', resolveExit));
  if (exitCode !== 0) throw new Error(`${label || handler} failed: ${stderr || stdout}`);
  return stdout;
}

export async function readLatestPromptPackage({ dataHome, projectDir }) {
  return JSON.parse(await callMcp({ dataHome, projectDir, handler: 'handleGetLatestPromptPackage', label: 'MCP latest Prompt Package read' }));
}

export async function readRoundArtifact({ dataHome, projectDir, packageId, artifact }) {
  return await callMcp({ dataHome, projectDir, handler: 'handleGetRoundArtifact', args: { package_id: packageId, artifact }, label: `MCP ${artifact} read` });
}

export async function readLatestArtifactReview({ dataHome, projectDir }) {
  return JSON.parse(await callMcp({ dataHome, projectDir, handler: 'handleGetLatestArtifactReview', label: 'MCP latest Artifact Review read' }));
}

export async function readArtifactReviewPageVisual({ dataHome, projectDir, packageId, pageId }) {
  const code = `
    import { createHash } from 'node:crypto';
    const server = await import('./mcp/server.mjs?browser-harness-visual=${Date.now()}');
    const result = await server.handleGetArtifactReviewPageVisual(${JSON.stringify({ package_id: packageId, page_id: pageId })});
    if (result.isError) throw new Error(result.content?.[0]?.text || 'MCP visual read failed');
    const image = result.content.find((item) => item.type === 'image');
    const bytes = Buffer.from(image.data, 'base64');
    process.stdout.write(JSON.stringify({ types: result.content.map((item) => item.type), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: root,
    env: harnessEnv({ dataHome, projectDir, extra: { CANVAS_PROMPT_MCP_TEST: '1' } }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolveExit) => child.once('exit', resolveExit));
  if (exitCode !== 0) throw new Error(`MCP Artifact Review visual read failed: ${stderr || stdout}`);
  return JSON.parse(stdout);
}

export async function removeSandbox(sandbox) {
  await rm(sandbox, { recursive: true, force: true });
}
