import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

process.env.CANVAS_PROMPT_MCP_TEST = '1';
const { latestPackageResponse, readTrustedCanvasArtifact, TOOLS, PROJECT_SCOPE_ERROR } = await import('./server.mjs');

test('MCP refuses to silently bind its artifact reads to the plugin directory', () => {
  assert.match(PROJECT_SCOPE_ERROR, /CANVAS_PROMPT_PROJECT_DIR/);
});

test('latest package response excludes inline image data while retaining image metadata and engine paths', () => {
  const response = JSON.parse(latestPackageResponse({
    meta: { package_id: 'pp_fixture' },
    transcript: { full_text: '保留语音内容' },
    timeline: [{ event_id: 'evt_1' }],
    canvas_snapshot: {
      final: { url: 'data:image/png;base64,very-large-image', format: 'png', width: 1200, height: 800 },
      keyframes: [{ timestamp_ms: 1000, image: { url: 'data:image/webp;base64,another-image', format: 'webp', width: 600, height: 400 } }],
    },
  }, '/tmp/project/.canvas-prompt/latest-prompt-package.json'));

  const text = JSON.stringify(response);
  assert.equal(text.includes('data:image/'), false);
  assert.equal(response.package.canvas_snapshot.final.inline_data, 'excluded');
  assert.equal(response.package.canvas_snapshot.final.width, 1200);
  assert.equal(response.package.canvas_snapshot.keyframes[0].image.format, 'webp');
  assert.equal(response.package.transcript.full_text, '保留语音内容');
  assert.equal(response.source.raw_package_path, '/tmp/project/.canvas-prompt/latest-prompt-package.json');
  assert.equal(response.source.compact_package_path, '/tmp/project/.canvas-prompt/rounds/pp_fixture/engine/compact-package.json');
});

test('public MCP schema exposes only fixed-scope round reads, never caller paths', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), ['get_latest_prompt_package', 'get_round_artifact']);
  const schema = JSON.stringify(TOOLS);
  assert.equal(schema.includes('events_path'), false);
  assert.equal(schema.includes('transcript_path'), false);
  assert.equal(schema.includes('Optional absolute replacement path'), false);
  assert.equal(schema.includes('"path"'), false);
  assert.match(schema, /package_id/);
});

test('a legal large raw package is readable before image data is stripped for MCP', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-mcp-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canvasDir = resolve(root, '.canvas-prompt');
  await mkdir(canvasDir, { recursive: true });
  const large = JSON.stringify({
    meta: { package_id: 'pp_large' },
    canvas_snapshot: { final: { url: `data:image/png;base64,${'A'.repeat(6 * 1024 * 1024)}`, format: 'png', width: 100, height: 100 } },
  });
  const filePath = resolve(canvasDir, 'latest-prompt-package.json');
  await writeFile(filePath, large);
  const trusted = await readTrustedCanvasArtifact(filePath, ['latest-prompt-package.json'], { canvasPromptDir: canvasDir, maxBytes: 32 * 1024 * 1024 });
  const response = latestPackageResponse(JSON.parse(trusted.contents), trusted.path);
  assert.equal(response.includes('data:image/'), false);
  await assert.rejects(
    readTrustedCanvasArtifact(filePath, ['latest-prompt-package.json'], { canvasPromptDir: canvasDir, maxBytes: 4 * 1024 * 1024 }),
    /read limit/,
  );
});

test('round artifact reads resolve the published Process IR path for the active project', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-mcp-round-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const roundDir = resolve(root, '.canvas-prompt', 'rounds', 'pp_round', 'engine');
  await mkdir(roundDir, { recursive: true });
  await writeFile(resolve(root, '.canvas-prompt', 'rounds', 'pp_round', 'prompt-package.json'), JSON.stringify({ meta: { package_id: 'pp_round' } }));
  await writeFile(resolve(roundDir, 'process-ir.json'), JSON.stringify({ schema_version: 'process-ir-v0.4', source: { package_id: 'pp_round' } }));
  await writeFile(resolve(roundDir, 'compact-package.json'), JSON.stringify({ schema_version: 'compact-package-v2.2', source_provenance: { package_id: 'pp_round' } }));

  const previousProject = process.env.CANVAS_PROMPT_PROJECT_DIR;
  process.env.CANVAS_PROMPT_PROJECT_DIR = root;
  const scoped = await import(`./server.mjs?round-artifact-test=${Date.now()}`);
  try {
    const processIr = await scoped.handleGetRoundArtifact({ package_id: 'pp_round', artifact: 'process_ir' });
    const compact = await scoped.handleGetRoundArtifact({ package_id: 'pp_round', artifact: 'compact_package' });
    assert.equal(processIr.isError, undefined);
    assert.equal(compact.isError, undefined);
    assert.equal(JSON.parse(processIr.content[0].text).source.package_id, 'pp_round');
    assert.equal(JSON.parse(compact.content[0].text).source_provenance.package_id, 'pp_round');
  } finally {
    if (previousProject === undefined) delete process.env.CANVAS_PROMPT_PROJECT_DIR;
    else process.env.CANVAS_PROMPT_PROJECT_DIR = previousProject;
  }
});
