#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createSandbox, availablePort, startVite, waitForHttp, loadPlaywright, chromePath, browserDiagnostics, stopChild, removeSandbox } from './browser-test-support.mjs';

const fixtures = [
  ['flowchart', 'flowchart LR\n A[Observe] --> B[Clarify]\n B --> C[Confirm]'],
  ['sequence', 'sequenceDiagram\n Student->>Teacher: Question\n Teacher-->>Student: Hint'],
  ['class', 'classDiagram\n class Canvas {\n +string id\n +draw()\n }\n class Round\n Canvas --> Round'],
  ['er', 'erDiagram\n BOARD ||--o{ ROUND : contains\n BOARD {\n string id\n }\n ROUND {\n string id\n }'],
];
const sandbox = await createSandbox('canvas-mermaid-regression-');
const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const server = startVite({ port, dataHome: sandbox.dataHome, projectDir: sandbox.projectDir });
let browser;
try {
  await waitForHttp(`${origin}/`, server.child);
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const diagnostics = browserDiagnostics(page);
  await page.goto(`${origin}/tests/mermaid-runtime.html`);
  await page.waitForFunction(() => window.mermaidReady?.(), undefined, { timeout: 20_000 });
  diagnostics.assertClean();
  const results = [];
  for (const [name, source] of fixtures) {
    const errorsBefore = diagnostics.errors.length;
    const first = await page.evaluate((definition) => window.testMermaidImport(definition), source);
    const second = await page.evaluate((definition) => window.testMermaidImport(definition), source);
    assert(first.count > 0 && second.count === first.count);
    assert(second.ids.every((id) => !first.ids.includes(id)), `${name}: IDs reused between imports`);
    const errors = diagnostics.errors.slice(errorsBefore);
    // Reproduced on public main e344b509 (Mermaid 11.16.0, converter 2.2.2):
    // class/ER currently fall back to one SVG image. Keep this limitation
    // explicit; moving an image does not prove editable diagram internals.
    const knownFallback = name === 'class'
      ? /^console: Error processing Mermaid diagram: Error: DOM Node with id classId-Canvas-\d+ not found\n/
      : name === 'er'
        ? /^console: Error processing Mermaid diagram: Error: ER entity entity-BOARD-\d+ not found in rendered SVG\n/
        : null;
    if (knownFallback) {
      assert.equal(first.count, 1);
      assert.deepEqual(first.types, ['image']);
      assert.deepEqual(second.types, ['image']);
      assert.equal(errors.length, 2);
      assert(errors.every((message) => knownFallback.test(message)), `${name}: unexpected browser error`);
    } else {
      assert(!first.types.includes('image'), `${name}: unexpectedly fell back to image`);
      assert.deepEqual(errors, []);
    }
    results.push({ name, elements: first.count, mode: knownFallback ? 'known-baseline-svg-fallback' : 'editable-diagram', objectMovable: first.edited && second.edited, diagramInternalsEditable: !knownFallback, idsUniqueAcrossImports: true, expectedFallbackWarnings: errors.length, types: first.types });
  }
  assert.deepEqual(diagnostics.httpErrors, []);
  console.log(JSON.stringify({ ok: true, results, isolated: true, productFilesChanged: false, limitation: 'Class and ER fallback is inherited from main, not new native-editability evidence.' }, null, 2));
} finally {
  await browser?.close().catch(() => undefined);
  await stopChild(server.child);
  await removeSandbox(sandbox.sandbox);
}
