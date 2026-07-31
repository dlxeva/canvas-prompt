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
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { resolve, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConversationScope, threadScopeKey, validSessionId, validThreadId } from '../app/conversation-scope.mjs';

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
// One user has one active Canvas Prompt board. The MCP reader is intentionally
// global to that private board, so an explicit continuation command in any
// conversation reads the latest completed round without routing by project or
// guessed chat history. Project/thread values remain package provenance only.
const configuredConversationScope = resolveConversationScope({ projectDir: ACTIVE_PROJECT_DIR, singleBoard: true });
const PROJECT_SCOPE_ERROR = null;
const CANVAS_PROMPT_DIR = configuredConversationScope?.canvasDir ?? null;
const MAX_LATEST_PACKAGE_TEXT_BYTES = 1_500_000;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
// Large local Packages can be reconstructed from bounded browser checkpoints.
// This controls only trusted local artifact reading; latestPackageResponse
// still strips inline media and caps model-facing text at 1.5MB.
const MAX_RAW_PACKAGE_BYTES = 256 * 1024 * 1024;
const ROUND_ARTIFACTS = {
  prompt_package: ['prompt-package.json'],
  compact_package: ['engine', 'compact-package.json'],
  process_ir: ['engine', 'process-ir.json'],
  manifest: ['round.json'],
  handoff: ['handoff.json'],
};

function latestPromptPackagePath(canvasPromptDir = CANVAS_PROMPT_DIR) {
  return resolve(canvasPromptDir, 'latest-prompt-package.json');
}

const sessionIndexPath = (sessionId) => resolve(homedir(), '.canvas-prompt', 'session-index', `${threadScopeKey(sessionId)}.json`);

async function sessionScopeFromCapability(sessionId) {
  if (!validSessionId(sessionId)) throw new Error('Canvas Prompt session capability is missing or invalid.');
  let registration;
  try {
    registration = JSON.parse(await readFile(sessionIndexPath(sessionId), 'utf8'));
  } catch {
    throw new Error('Canvas Prompt session capability was not found on this device. Reopen the canvas in this conversation.');
  }
  if (registration?.session_id !== sessionId || typeof registration?.project_dir !== 'string') {
    throw new Error('Canvas Prompt session capability is invalid.');
  }
  return resolveConversationScope({ projectDir: registration.project_dir, sessionId });
}

async function resolveReadScope(args = {}) {
  // Legacy launch capabilities are accepted for old archives, but must not
  // divert the normal single-board continuation path.
  if (typeof args.session_id === 'string') return sessionScopeFromCapability(args.session_id);
  return configuredConversationScope;
}

function safePackageId(packageId) {
  return typeof packageId === 'string' && /^[A-Za-z0-9_-]+$/.test(packageId);
}

function pathIsInside(root, candidate) {
  const value = relative(root, candidate);
  return value !== '' && !value.startsWith('..') && !value.includes(process.platform === 'win32' ? '..\\' : '../');
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

async function resolveRoundArtifact(packageId, artifact, canvasPromptDir) {
  if (!safePackageId(packageId) || !Object.hasOwn(ROUND_ARTIFACTS, artifact)) {
    throw new Error('Invalid round artifact request.');
  }
  const parts = ROUND_ARTIFACTS[artifact];
  const candidate = resolve(canvasPromptDir, 'rounds', packageId, ...parts);
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

function editableSourceImagePaths(filePath, packageId, rawPackage) {
  if (!packageId || !Array.isArray(rawPackage?.source_images)) return [];
  const roundDir = basename(filePath) === 'prompt-package.json'
    ? dirname(filePath)
    : resolve(dirname(filePath), 'rounds', packageId);
  return rawPackage.source_images.flatMap((image) => {
    if (!image || image.availability !== 'available' || typeof image.archive_relative_path !== 'string') return [];
    const candidate = resolve(roundDir, image.archive_relative_path);
    if (!pathIsInside(roundDir, candidate) || !existsSync(candidate)) return [];
    return [{
      artifact_object_id: image.artifact_object_id,
      asset_id: image.asset_id,
      path: candidate,
      mime_type: image.mime_type,
      width: image.width,
      height: image.height,
    }];
  });
}

function packageEnginePaths(filePath, packageId, rawPackage) {
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
      editable_source_images: editableSourceImagePaths(filePath, packageId, rawPackage),
    } : {}),
  };
}

function latestPackageResponse(rawPackage, filePath) {
  const packageWithoutInlineImages = stripInlineImageData(rawPackage);
  const response = {
    package: packageWithoutInlineImages,
    source: packageEnginePaths(filePath, rawPackage?.meta?.package_id, rawPackage),
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
    source: packageEnginePaths(filePath, rawPackage?.meta?.package_id, rawPackage),
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
  try {
    const scope = await resolveReadScope(args);
    const filePath = latestPromptPackagePath(scope.canvasDir);
    if (!existsSync(filePath)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Prompt Package not found for this Canvas Prompt session.',
            hint: 'Finish and export a Canvas Prompt round in this conversation first.',
          }),
        }],
        isError: true,
      };
    }
    const trusted = await readTrustedCanvasArtifact(filePath, ['latest-prompt-package.json'], { canvasPromptDir: scope.canvasDir, maxBytes: MAX_RAW_PACKAGE_BYTES });
    const rawPackage = JSON.parse(trusted.contents);
    return { content: [{ type: 'text', text: latestPackageResponse(rawPackage, trusted.path) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
  }
}

async function handleGetRoundArtifact(args = {}) {
  try {
    const scope = await resolveReadScope(args);
    const trusted = await resolveRoundArtifact(args.package_id, args.artifact, scope.canvasDir);
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
  version: '0.1.34',
};

// Mirror the official MCP SDK negotiation policy. Codex Desktop now starts
// clients with a post-2024 protocol version; responding with 2024-11-05
// unconditionally makes the host reject the server before its tools appear.
const LATEST_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];
const negotiateProtocolVersion = (requestedVersion) => (
  SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
    ? requestedVersion
    : LATEST_PROTOCOL_VERSION
);

// ============================================================
// JSON-RPC Helpers
// ============================================================

/**
 * 写一条 JSON-RPC 消息到 stdout
 */
// Modern MCP stdio uses one JSON-RPC message per line. Earlier local hosts in
// our compatibility matrix used LSP-style Content-Length framing. Learn the
// host framing from its first request and reply in kind: this keeps Codex
// Desktop interoperable without breaking those older local hosts.
let responseFraming = 'newline';

function encodeResponse(obj, framing = responseFraming) {
  const json = JSON.stringify(obj);
  return framing === 'content-length'
    ? `Content-Length: ${Buffer.byteLength(json, 'utf-8')}\r\n\r\n${json}`
    : `${json}\n`;
}

function send(obj) {
  process.stdout.write(encodeResponse(obj));
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
    description: 'Read the latest completed Prompt Package from the user\'s single active Canvas Prompt board.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_round_artifact',
    description: 'Read one bounded artifact from an immutable round in the user\'s single active Canvas Prompt board.',
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
        session_id: {
          type: 'string',
          description: 'Opaque Canvas Prompt launch capability from this conversation.',
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
        protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
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
          responseFraming = 'content-length';
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
          responseFraming = 'newline';
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
  encodeResponse,
  negotiateProtocolVersion,
  TOOLS,
  PROJECT_SCOPE_ERROR,
};
