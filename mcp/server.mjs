#!/usr/bin/env node

/**
 * MCP Server for AI思考白板 (AI Thinking Whiteboard)
 *
 * 暴露以下工具：
 *   1. get_cognitive_events   — 读取 cognitive_events.jsonl，返回认知事件流
 *   2. export_prompt_package  — 调用 prompt-package-compiler 生成 Prompt Package
 *   3. get_voice_transcript   — 读取语音转写文件，返回文本
 *
 * 使用 JSON-RPC 2.0 over stdin/stdout 协议（Model Context Protocol）。
 * 参考 Cowart 的 MCP 实现模式。
 */

import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConversationScope, validThreadId } from '../app/conversation-scope.mjs';

// ============================================================
// Constants
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

/**
 * Project scope is fixed when MCP starts; callers cannot replace it. A plugin
 * installation directory is never a safe fallback: it would blend one user's
 * active project with another project's Canvas rounds.
 */
const CONFIGURED_PROJECT_DIR = process.env.CANVAS_PROMPT_PROJECT_DIR;
const CONFIGURED_THREAD_ID = process.env.CANVAS_PROMPT_THREAD_ID;
const REQUIRE_THREAD = process.env.CANVAS_PROMPT_REQUIRE_THREAD === '1';
const ACTIVE_PROJECT_DIR = CONFIGURED_PROJECT_DIR ? resolve(CONFIGURED_PROJECT_DIR) : null;
const conversationScope = (ACTIVE_PROJECT_DIR || validThreadId(CONFIGURED_THREAD_ID))
  ? resolveConversationScope({ projectDir: ACTIVE_PROJECT_DIR, threadId: CONFIGURED_THREAD_ID })
  : null;
const PROJECT_SCOPE_ERROR = REQUIRE_THREAD && !validThreadId(CONFIGURED_THREAD_ID)
  ? 'Canvas Prompt MCP requires an explicit host-provided conversation thread ID; refusing to guess a current conversation.'
  : !conversationScope
    ? 'Canvas Prompt MCP was not given CANVAS_PROMPT_PROJECT_DIR or an explicit conversation thread ID; refusing to read the plugin installation directory.'
  : ACTIVE_PROJECT_DIR === PROJECT_ROOT
    ? 'Canvas Prompt MCP project directory resolves to the plugin installation directory; refusing to read it.'
    : null;
const CANVAS_PROMPT_DIR = conversationScope?.canvasDir ?? null;
const MAX_LATEST_PACKAGE_TEXT_BYTES = 1_500_000;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_RAW_PACKAGE_BYTES = 32 * 1024 * 1024;
const ROUND_ARTIFACTS = {
  prompt_package: ['prompt-package.json'],
  compact_package: ['engine', 'compact-package.json'],
  process_ir: ['engine', 'process-ir.json'],
  manifest: ['round.json'],
  handoff: ['handoff.json'],
};

function latestPromptPackagePath() {
  return resolve(CANVAS_PROMPT_DIR, 'latest-prompt-package.json');
}

function safePackageId(packageId) {
  return typeof packageId === 'string' && /^[A-Za-z0-9_-]+$/.test(packageId);
}

function pathIsInside(root, candidate) {
  const value = relative(root, candidate);
  return value !== '' && !value.startsWith('..') && !value.includes(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

async function readTrustedCanvasArtifact(candidatePath, allowedNames, { canvasPromptDir = CANVAS_PROMPT_DIR, maxBytes = MAX_ARTIFACT_BYTES } = {}) {
  const [root, candidate] = await Promise.all([realpath(canvasPromptDir), realpath(candidatePath)]);
  if (!pathIsInside(root, candidate) || !allowedNames.includes(basename(candidate))) {
    throw new Error('Requested artifact is outside the active project canvas storage.');
  }
  const info = await stat(candidate);
  if (!info.isFile()) throw new Error('Requested artifact is not a file.');
  if (info.size > maxBytes) throw new Error(`Requested artifact exceeds ${maxBytes} byte read limit.`);
  return { path: candidate, contents: await readFile(candidate, 'utf8') };
}

async function resolveRoundArtifact(packageId, artifact) {
  if (!safePackageId(packageId) || !Object.hasOwn(ROUND_ARTIFACTS, artifact)) {
    throw new Error('Invalid round artifact request.');
  }
  const parts = ROUND_ARTIFACTS[artifact];
  const candidate = resolve(CANVAS_PROMPT_DIR, 'rounds', packageId, ...parts);
  return readTrustedCanvasArtifact(candidate, [parts.at(-1)], {
    maxBytes: artifact === 'prompt_package' ? MAX_RAW_PACKAGE_BYTES : MAX_ARTIFACT_BYTES,
  });
}

function stripInlineImageData(value) {
  if (Array.isArray(value)) return value.map(stripInlineImageData);
  if (!value || typeof value !== 'object') return value;
  const record = value;
  const result = {};
  for (const [key, nested] of Object.entries(record)) {
    if (key === 'url' && typeof nested === 'string' && nested.startsWith('data:image/')) {
      // Preserve the surrounding image metadata (format, width and height),
      // but never place an inline image blob in the model context by default.
      result.inline_data = 'excluded';
      continue;
    }
    result[key] = stripInlineImageData(nested);
  }
  return result;
}

function packageEnginePaths(filePath, packageId) {
  const fileName = basename(filePath);
  const canvasPromptDir = dirname(filePath);
  const roundDir = fileName === 'prompt-package.json'
    ? canvasPromptDir
    : packageId
      ? resolve(canvasPromptDir, 'rounds', packageId)
      : null;
  return {
    raw_package_path: filePath,
    ...(roundDir ? {
      compact_package_path: resolve(roundDir, 'engine', 'compact-package.json'),
      process_ir_path: resolve(roundDir, 'engine', 'process-ir.json'),
      canvas_snapshot_path: resolve(roundDir, 'canvas-snapshot.png'),
    } : {}),
  };
}

function latestPackageResponse(rawPackage, filePath) {
  const packageWithoutInlineImages = stripInlineImageData(rawPackage);
  const response = {
    package: packageWithoutInlineImages,
    source: packageEnginePaths(filePath, rawPackage?.meta?.package_id),
    delivery: {
      inline_image_data: 'excluded',
      max_text_bytes: MAX_LATEST_PACKAGE_TEXT_BYTES,
      preferred_reading_order: ['compact_package_path', 'process_ir_path', 'raw_package_path'],
    },
  };
  const text = JSON.stringify(response);
  if (Buffer.byteLength(text, 'utf-8') <= MAX_LATEST_PACKAGE_TEXT_BYTES) return text;

  // A pathological raw package can still be oversized because of dense stroke
  // points. Return the sufficient index rather than silently truncating JSON.
  return JSON.stringify({
    package: {
      meta: packageWithoutInlineImages.meta,
      transcript: packageWithoutInlineImages.transcript,
      canvas_snapshot: packageWithoutInlineImages.canvas_snapshot,
      timeline: packageWithoutInlineImages.timeline,
      objects: packageWithoutInlineImages.objects,
      review_items: packageWithoutInlineImages.review_items,
      transformations: packageWithoutInlineImages.transformations,
      transform_bindings: packageWithoutInlineImages.transform_bindings,
      intent_summary: packageWithoutInlineImages.intent_summary,
    },
    source: packageEnginePaths(filePath, rawPackage?.meta?.package_id),
    delivery: {
      inline_image_data: 'excluded',
      max_text_bytes: MAX_LATEST_PACKAGE_TEXT_BYTES,
      output_truncated: true,
      omitted_fields: ['strokes', 'pointer_track.samples', 'canvas_snapshot.keyframes'],
      preferred_reading_order: ['compact_package_path', 'process_ir_path', 'raw_package_path'],
    },
  });
}

async function handleGetLatestPromptPackage(args = {}) {
  if (PROJECT_SCOPE_ERROR) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: PROJECT_SCOPE_ERROR, project_scope: 'unbound' }) }], isError: true };
  }
  const filePath = latestPromptPackagePath();
  if (!existsSync(filePath)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: `Prompt Package not found: ${filePath}`,
          hint: 'Open Canvas Prompt for this project and export a session first.',
        }),
      }],
      isError: true,
    };
  }
  try {
    const trusted = await readTrustedCanvasArtifact(filePath, ['latest-prompt-package.json'], { maxBytes: MAX_RAW_PACKAGE_BYTES });
    const rawPackage = JSON.parse(trusted.contents);
    return { content: [{ type: 'text', text: latestPackageResponse(rawPackage, trusted.path) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
  }
}

async function handleGetRoundArtifact(args = {}) {
  if (PROJECT_SCOPE_ERROR) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: PROJECT_SCOPE_ERROR, project_scope: 'unbound' }) }], isError: true };
  }
  try {
    const trusted = await resolveRoundArtifact(args.package_id, args.artifact);
    if (args.artifact === 'prompt_package') {
      return { content: [{ type: 'text', text: latestPackageResponse(JSON.parse(trusted.contents), trusted.path) }] };
    }
    return { content: [{ type: 'text', text: trusted.contents }] };
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
  }
}

const SERVER_INFO = {
  name: 'ai-thinking-whiteboard-mcp',
  version: '0.1.11',
};

const PROTOCOL_VERSION = '2024-11-05';

// ============================================================
// JSON-RPC Helpers
// ============================================================

/**
 * 写一条 JSON-RPC 消息到 stdout
 */
function send(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf-8')}\r\n\r\n${json}`);
}

/**
 * 成功响应
 */
function result(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

/**
 * 错误响应
 */
function error(id, code, message, data) {
  send({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

// ============================================================
// MCP Protocol Handler
// ============================================================

const TOOLS = [
  {
    name: 'get_latest_prompt_package',
    description: 'Read the latest Prompt Package inside this fixed Canvas Prompt project/conversation scope. The server never guesses a current conversation.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_round_artifact',
    description: 'Read one bounded artifact from an immutable Canvas Prompt round in this fixed project/conversation scope.',
    inputSchema: {
      type: 'object',
      properties: {
        package_id: {
          type: 'string',
          description: 'Immutable Canvas Prompt round package ID.',
        },
        artifact: {
          type: 'string',
          enum: ['prompt_package', 'compact_package', 'process_ir', 'manifest', 'handoff'],
          description: 'One approved immutable-round artifact kind.',
        },
      },
      required: ['package_id', 'artifact'],
    },
  },
];

async function handleRequest(req) {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize': {
      result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
      });
      return;
    }

    case 'notifications/initialized': {
      // 通知，无需响应
      return;
    }

    case 'tools/list': {
      result(id, { tools: TOOLS });
      return;
    }

    case 'tools/call': {
      const { name, arguments: args } = params;
      let response;

      switch (name) {
        case 'get_latest_prompt_package':
          response = await handleGetLatestPromptPackage(args);
          break;
        case 'get_round_artifact':
          response = await handleGetRoundArtifact(args);
          break;
        default:
          error(id, -32601, `Unknown tool: ${name}`);
          return;
      }

      result(id, response);
      return;
    }

    case 'ping': {
      result(id, {});
      return;
    }

    default: {
      if (method?.startsWith('notifications/')) {
        return; // 忽略未知通知
      }
      error(id, -32601, `Method not found: ${method}`);
    }
  }
}

// ============================================================
// stdin/stdout Transport
// ============================================================

function startServer() {
  let buffer = '';

  process.stdin.setEncoding('utf-8');

  process.stdin.on('data', (chunk) => {
    buffer += chunk;

    while (buffer.length > 0) {
      // 查找 Content-Length 头（MCP 标准协议）
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const header = buffer.substring(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (match) {
          const contentLength = parseInt(match[1], 10);
          const bodyStart = headerEnd + 4;

          if (Buffer.byteLength(buffer.substring(bodyStart), 'utf-8') < contentLength) {
            break; // 数据不完整，等待更多
          }

          const body = buffer.substring(bodyStart, bodyStart + contentLength);
          buffer = buffer.substring(bodyStart + contentLength);

          try {
            const req = JSON.parse(body);
            handleRequest(req).catch((err) => {
              if (req.id !== undefined) {
                error(req.id, -32603, `Internal error: ${err.message}`);
              }
            });
          } catch {
            send({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error' },
            });
          }
          continue;
        }
      }

      // 回退：按行解析（兼容简单 JSON-RPC 输入）
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) break;

      const line = buffer.substring(0, newlineIdx).trim();
      buffer = buffer.substring(newlineIdx + 1);

      if (line) {
        try {
          const req = JSON.parse(line);
          handleRequest(req).catch((err) => {
            if (req.id !== undefined) {
              error(req.id, -32603, `Internal error: ${err.message}`);
            }
          });
        } catch {
          // 忽略无法解析的行
        }
      }
    }
  });

  process.stdin.on('end', () => {
    process.exit(0);
  });

  process.stderr.write(`[${SERVER_INFO.name}] MCP server started (stdio transport)\n`);
  process.stderr.write(`[${SERVER_INFO.name}] Project dir: ${PROJECT_SCOPE_ERROR ? 'unbound' : ACTIVE_PROJECT_DIR}\n`);
  if (PROJECT_SCOPE_ERROR) process.stderr.write(`[${SERVER_INFO.name}] ${PROJECT_SCOPE_ERROR}\n`);
}

// ============================================================
// Main
// ============================================================

if (process.env.CANVAS_PROMPT_MCP_TEST !== '1') startServer();

export {
  handleGetLatestPromptPackage,
  handleGetRoundArtifact,
  latestPackageResponse,
  readTrustedCanvasArtifact,
  resolveRoundArtifact,
  stripInlineImageData,
  TOOLS,
  PROJECT_SCOPE_ERROR,
};
