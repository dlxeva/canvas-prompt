import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { sessionScopeKey, threadScopeKey } from '../app/conversation-scope.mjs';

process.env.CANVAS_PROMPT_MCP_TEST = '1';
const { encodeResponse, negotiateProtocolVersion, latestPackageResponse, readTrustedCanvasArtifact, TOOLS, PROJECT_SCOPE_ERROR } = await import('./server.mjs');

test('MCP emits newline-delimited JSON for modern stdio hosts and preserves Content-Length compatibility', () => {
  const message = { jsonrpc: '2.0', id: 1, result: {} };
  assert.equal(encodeResponse(message, 'newline'), `${JSON.stringify(message)}\n`);
  assert.equal(
    encodeResponse(message, 'content-length'),
    `Content-Length: ${Buffer.byteLength(JSON.stringify(message), 'utf-8')}\r\n\r\n${JSON.stringify(message)}`,
  );
});

test('MCP negotiates a protocol version compatible with the requesting host', () => {
  assert.equal(negotiateProtocolVersion('2025-06-18'), '2025-06-18');
  assert.equal(negotiateProtocolVersion('2024-11-05'), '2024-11-05');
  assert.equal(negotiateProtocolVersion('future-protocol'), '2025-11-25');
});

test('MCP binds to the private single-board archive, never the plugin directory', () => {
  assert.equal(PROJECT_SCOPE_ERROR, null);
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

test('latest package response exposes an archived editable original only from its own round', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-mcp-source-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const roundDir = resolve(root, '.canvas-prompt', 'rounds', 'pp_source');
  await mkdir(resolve(roundDir, 'source-images'), { recursive: true });
  const originalPath = resolve(roundDir, 'source-images', 'img_logo.png');
  await writeFile(originalPath, 'not-a-real-png');

  const response = JSON.parse(latestPackageResponse({
    meta: { package_id: 'pp_source' },
    source_images: [{
      artifact_object_id: 'obj_img_logo', asset_id: 'file_logo', mime_type: 'image/png', width: 1200, height: 800,
      archive_relative_path: 'source-images/img_logo.png', availability: 'available',
    }],
  }, resolve(roundDir, 'prompt-package.json')));

  assert.deepEqual(response.source.editable_source_images, [{
    artifact_object_id: 'obj_img_logo', asset_id: 'file_logo', path: originalPath, mime_type: 'image/png', width: 1200, height: 800,
  }]);
});

test('public MCP schema exposes only fixed-scope round reads, never caller paths', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), ['get_latest_prompt_package', 'get_latest_artifact_review', 'get_latest_interaction_review', 'get_artifact_review_page_visual', 'get_round_artifact']);
  const schema = JSON.stringify(TOOLS);
  assert.equal(schema.includes('events_path'), false);
  assert.equal(schema.includes('transcript_path'), false);
  assert.equal(schema.includes('Optional absolute replacement path'), false);
  assert.equal(schema.includes('"path"'), false);
  assert.match(schema, /package_id/);
});

test('latest Artifact Review uses progressive disclosure and omits dense gesture points', async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), 'canvas-mcp-artifact-review-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const board = resolve(home, '.canvas-prompt', 'board');
  const packageId = 'arp_reader_fixture';
  const round = resolve(board, 'artifact-review-rounds', packageId);
  const visualDir = resolve(round, 'visual-evidence');
  await mkdir(visualDir, { recursive: true });
  const rawPackage = {
    schema_version: 'artifact-review/0.2-draft', package_id: packageId,
    artifact: { artifact_kind: 'pdf', source_sha256: 'a'.repeat(64), page_count: 1, read_only: true },
    pages: [{ page_id: 'page_fixture_1', page_number: 1 }],
    annotations: [{ annotation_id: 'ann_fixture', page_id: 'page_fixture_1', kind: 'ink', gesture_points: [{ x_ratio: 0.1, y_ratio: 0.2 }] }],
    voice_segments: [{ segment_id: 'voice_fixture', start_ms: 1, end_ms: 2, text: '这里要改' }],
    page_visits: [{ page_number: 1, at_ms: 0 }], review_state: { interpretation_status: 'clarification_required', execution_authorized: false },
  };
  await writeFile(resolve(board, 'latest-artifact-review-package.json'), JSON.stringify(rawPackage));
  await writeFile(resolve(round, 'artifact-review-package.json'), JSON.stringify(rawPackage));
  await writeFile(resolve(round, 'review-brief.json'), JSON.stringify({ schema_version: 'artifact-review-proposal/0.1-draft', execution_authorized: false }));
  const visualBytes = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  const renderRef = `vre_${'b'.repeat(36)}`;
  await writeFile(resolve(visualDir, `${renderRef}.png`), visualBytes);
  await writeFile(resolve(visualDir, 'manifest.json'), JSON.stringify({
    schema_version: 'artifact-review-visual-evidence/0.1-draft', package_id: packageId,
    total_byte_length: visualBytes.byteLength,
    pages: [{ page_id: 'page_fixture_1', render_ref: renderRef, media_type: 'image/png', width: 1, height: 1, byte_length: visualBytes.byteLength, sha256: createHash('sha256').update(visualBytes).digest('hex') }],
  }));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const scoped = await import(`./server.mjs?artifact-review-reader=${Date.now()}`);
  try {
    const result = await scoped.handleGetLatestArtifactReview();
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.package.package_id, packageId);
    assert.deepEqual(parsed.package.page_summary, [{ page_number: 1, annotation_count: 1, kinds: { ink: 1 } }]);
    assert.equal('gesture_points' in parsed.package.annotations[0], false);
    assert.equal(parsed.source.source_file_included, false);
    assert.equal(parsed.source.local_paths_included, false);
    assert.equal(parsed.source.storage_scope, 'single_board_local_archive');
    assert.equal(result.content[0].text.includes(home), false);
    assert.equal(result.content[0].text.includes('latest-artifact-review-package.json'), false);
    assert.equal(result.content[0].text.includes('review-brief.json'), false);
    assert.equal(result.content[0].text.includes('manifest.json'), false);
    assert.equal(parsed.delivery.mode, 'progressive_disclosure');
    assert.deepEqual(parsed.visual_evidence.pages, [{
      page_id: 'page_fixture_1', media_type: 'image/png', width: 1, height: 1,
      byte_length: visualBytes.byteLength, sha256: createHash('sha256').update(visualBytes).digest('hex'),
    }]);
    assert.equal(JSON.stringify(parsed.visual_evidence).includes(renderRef), false);

    const visual = await scoped.handleGetArtifactReviewPageVisual({ package_id: packageId, page_id: 'page_fixture_1' });
    assert.equal(visual.isError, undefined);
    assert.deepEqual(visual.content.map((item) => item.type), ['text', 'image']);
    assert.equal(visual.content[1].data, visualBytes.toString('base64'));
    assert.equal(visual.content[1].mimeType, 'image/png');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('Artifact Review page visual fails closed on missing pages and integrity mismatch', async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), 'canvas-mcp-artifact-visual-integrity-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const board = resolve(home, '.canvas-prompt', 'board');
  const packageId = 'arp_visual_integrity';
  const round = resolve(board, 'artifact-review-rounds', packageId);
  const visualDir = resolve(round, 'visual-evidence');
  await mkdir(visualDir, { recursive: true });
  const rawPackage = { schema_version: 'artifact-review/0.2-draft', package_id: packageId, pages: [{ page_id: 'page_one', page_number: 1 }] };
  await writeFile(resolve(round, 'artifact-review-package.json'), JSON.stringify(rawPackage));
  const bytes = Buffer.from('not-the-declared-image');
  const renderRef = `vre_${'c'.repeat(36)}`;
  await writeFile(resolve(visualDir, `${renderRef}.png`), bytes);
  await writeFile(resolve(visualDir, 'manifest.json'), JSON.stringify({
    schema_version: 'artifact-review-visual-evidence/0.1-draft', package_id: packageId, total_byte_length: bytes.byteLength,
    pages: [{ page_id: 'page_one', render_ref: renderRef, media_type: 'image/png', width: 1, height: 1, byte_length: bytes.byteLength, sha256: 'd'.repeat(64) }],
  }));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const scoped = await import(`./server.mjs?artifact-review-visual-integrity=${Date.now()}`);
  try {
    const missing = await scoped.handleGetArtifactReviewPageVisual({ package_id: packageId, page_id: 'page_missing' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /not archived for this page/);
    const corrupt = await scoped.handleGetArtifactReviewPageVisual({ package_id: packageId, page_id: 'page_one' });
    assert.equal(corrupt.isError, true);
    assert.match(corrupt.content[0].text, /integrity check/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('a legal large raw package is readable before image data is stripped for MCP', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-mcp-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canvasDir = resolve(root, '.canvas-prompt');
  await mkdir(canvasDir, { recursive: true });
  const large = JSON.stringify({
    meta: { package_id: 'pp_large' },
    canvas_snapshot: { final: { url: `data:image/png;base64,${'A'.repeat(35 * 1024 * 1024)}`, format: 'png', width: 100, height: 100 } },
  });
  assert.ok(Buffer.byteLength(large, 'utf8') > 32 * 1024 * 1024);
  const filePath = resolve(canvasDir, 'latest-prompt-package.json');
  await writeFile(filePath, large);
  const trusted = await readTrustedCanvasArtifact(filePath, ['latest-prompt-package.json'], { canvasPromptDir: canvasDir, maxBytes: 256 * 1024 * 1024 });
  const response = latestPackageResponse(JSON.parse(trusted.contents), trusted.path);
  assert.equal(response.includes('data:image/'), false);
  await assert.rejects(
    readTrustedCanvasArtifact(filePath, ['latest-prompt-package.json'], { canvasPromptDir: canvasDir, maxBytes: 4 * 1024 * 1024 }),
    /read limit/,
  );
});

test('round artifact reads resolve the published Process IR path from the single board', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-mcp-round-'));
  const home = await mkdtemp(resolve(tmpdir(), 'canvas-mcp-round-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const roundDir = resolve(home, '.canvas-prompt', 'board', 'rounds', 'pp_round', 'engine');
  await mkdir(roundDir, { recursive: true });
  await writeFile(resolve(home, '.canvas-prompt', 'board', 'rounds', 'pp_round', 'prompt-package.json'), JSON.stringify({ meta: { package_id: 'pp_round' } }));
  await writeFile(resolve(roundDir, 'process-ir.json'), JSON.stringify({ schema_version: 'process-ir-v0.4', source: { package_id: 'pp_round' } }));
  await writeFile(resolve(roundDir, 'compact-package.json'), JSON.stringify({ schema_version: 'compact-package-v2.2', source_provenance: { package_id: 'pp_round' } }));

  const previousProject = process.env.CANVAS_PROMPT_PROJECT_DIR;
  const previousHome = process.env.HOME;
  process.env.CANVAS_PROMPT_PROJECT_DIR = root;
  process.env.HOME = home;
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
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('MCP reads the single board latest package regardless of configured project/thread', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-mcp-thread-scope-'));
  const home = await mkdtemp(resolve(tmpdir(), 'canvas-mcp-thread-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const threadId = '019fa-mcp-thread-12345678';
  const scopedDir = resolve(home, '.canvas-prompt', 'board');
  await mkdir(scopedDir, { recursive: true });
  await writeFile(resolve(scopedDir, 'latest-prompt-package.json'), JSON.stringify({ meta: { package_id: 'pp_scoped' } }));
  const previousProject = process.env.CANVAS_PROMPT_PROJECT_DIR;
  const previousThread = process.env.CANVAS_PROMPT_THREAD_ID;
  const previousRequired = process.env.CANVAS_PROMPT_REQUIRE_THREAD;
  const previousHome = process.env.HOME;
  process.env.CANVAS_PROMPT_PROJECT_DIR = root;
  process.env.CANVAS_PROMPT_THREAD_ID = threadId;
  process.env.CANVAS_PROMPT_REQUIRE_THREAD = '1';
  process.env.HOME = home;
  const scoped = await import(`./server.mjs?thread-scope-test=${Date.now()}`);
  try {
    const result = await scoped.handleGetLatestPromptPackage();
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).package.meta.package_id, 'pp_scoped');
  } finally {
    if (previousProject === undefined) delete process.env.CANVAS_PROMPT_PROJECT_DIR;
    else process.env.CANVAS_PROMPT_PROJECT_DIR = previousProject;
    if (previousThread === undefined) delete process.env.CANVAS_PROMPT_THREAD_ID;
    else process.env.CANVAS_PROMPT_THREAD_ID = previousThread;
    if (previousRequired === undefined) delete process.env.CANVAS_PROMPT_REQUIRE_THREAD;
    else process.env.CANVAS_PROMPT_REQUIRE_THREAD = previousRequired;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('MCP reads only the round selected by this conversation launch capability', async (t) => {
  const project = await mkdtemp(resolve(tmpdir(), 'canvas-mcp-session-project-'));
  const home = await mkdtemp(resolve(tmpdir(), 'canvas-mcp-session-home-'));
  t.after(() => Promise.all([rm(project, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const sessionId = 'cpsessionmcp1234567890';
  const otherSessionId = 'cpsessionother12345678';
  const key = sessionScopeKey(sessionId);
  const otherKey = sessionScopeKey(otherSessionId);
  await mkdir(resolve(project, '.canvas-prompt', 'sessions', key), { recursive: true });
  await mkdir(resolve(project, '.canvas-prompt', 'sessions', otherKey), { recursive: true });
  await writeFile(resolve(project, '.canvas-prompt', 'sessions', key, 'latest-prompt-package.json'), JSON.stringify({ meta: { package_id: 'pp_this_task' } }));
  await writeFile(resolve(project, '.canvas-prompt', 'sessions', otherKey, 'latest-prompt-package.json'), JSON.stringify({ meta: { package_id: 'pp_other_task' } }));
  await mkdir(resolve(home, '.canvas-prompt', 'session-index'), { recursive: true });
  await writeFile(resolve(home, '.canvas-prompt', 'session-index', `${key}.json`), JSON.stringify({ version: 1, session_id: sessionId, project_dir: project }));
  const previousHome = process.env.HOME;
  delete process.env.CANVAS_PROMPT_PROJECT_DIR;
  process.env.HOME = home;
  const scoped = await import(`./server.mjs?session-capability-test=${Date.now()}`);
  try {
    const result = await scoped.handleGetLatestPromptPackage({ session_id: sessionId });
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).package.meta.package_id, 'pp_this_task');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('MCP needs no host thread ID for the single board', async (t) => {
  const previousProject = process.env.CANVAS_PROMPT_PROJECT_DIR;
  const previousThread = process.env.CANVAS_PROMPT_THREAD_ID;
  const previousRequired = process.env.CANVAS_PROMPT_REQUIRE_THREAD;
  const previousHome = process.env.HOME;
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-mcp-required-thread-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.CANVAS_PROMPT_PROJECT_DIR = root;
  process.env.HOME = root;
  delete process.env.CANVAS_PROMPT_THREAD_ID;
  process.env.CANVAS_PROMPT_REQUIRE_THREAD = '1';
  const scoped = await import(`./server.mjs?required-thread-test=${Date.now()}`);
  try {
    const result = await scoped.handleGetLatestPromptPackage();
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text).error, /Prompt Package not found/);
  } finally {
    if (previousProject === undefined) delete process.env.CANVAS_PROMPT_PROJECT_DIR;
    else process.env.CANVAS_PROMPT_PROJECT_DIR = previousProject;
    if (previousThread === undefined) delete process.env.CANVAS_PROMPT_THREAD_ID;
    else process.env.CANVAS_PROMPT_THREAD_ID = previousThread;
    if (previousRequired === undefined) delete process.env.CANVAS_PROMPT_REQUIRE_THREAD;
    else process.env.CANVAS_PROMPT_REQUIRE_THREAD = previousRequired;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
