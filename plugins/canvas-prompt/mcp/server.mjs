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
import { readFile } from 'node:fs/promises';
import { createMessageFramer } from './stdio-framer.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================
// Constants
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

/** 默认数据目录 */
const DATA_DIR = process.env.MCP_DATA_DIR || resolve(PROJECT_ROOT, 'data');

/** cognitive_events.jsonl 默认路径 */
const EVENTS_FILE = process.env.MCP_EVENTS_FILE || resolve(DATA_DIR, 'cognitive_events.jsonl');

/** 语音转写文件默认路径 */
const TRANSCRIPT_FILE = process.env.MCP_TRANSCRIPT_FILE || resolve(DATA_DIR, 'voice_transcript.txt');

function latestPromptPackagePath(projectDir) {
  const base = projectDir || process.env.CANVAS_PROMPT_PROJECT_DIR || process.cwd();
  return resolve(base, '.canvas-prompt', 'latest-prompt-package.json');
}

async function handleGetLatestPromptPackage(args = {}) {
  const filePath = args.path || latestPromptPackagePath(args.project_dir);
  if (!existsSync(filePath)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: `Prompt Package not found: ${filePath}`,
          hint: 'Open Canvas Prompt for this project and export a session first. Pass project_dir explicitly when the MCP server was started outside that project.',
        }),
      }],
      isError: true,
    };
  }
  try {
    return { content: [{ type: 'text', text: await readFile(filePath, 'utf-8') }] };
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
  }
}

const SERVER_INFO = {
  name: 'ai-thinking-whiteboard-mcp',
  version: '0.1.0',
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
// Tool Implementations
// ============================================================

/**
 * get_cognitive_events
 * 
 * 读取 cognitive_events.jsonl，每行一个 JSON 对象，返回事件数组。
 * 
 * 参数：
 *   - limit?: number   最多返回事件数（默认 1000）
 *   - offset?: number  跳过前 N 条事件（默认 0）
 *   - type?: string    按事件类型过滤（stroke|region|arrow|deletion|pause|...）
 *   - since?: number   只返回 timestamp >= since 的事件
 */
async function handleGetCognitiveEvents(args = {}) {
  const filePath = args.path || EVENTS_FILE;

  if (!existsSync(filePath)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: `File not found: ${filePath}`,
          hint: 'Set MCP_EVENTS_FILE env var or pass "path" argument.',
          events: [],
          total: 0,
        }),
      }],
      isError: true,
    };
  }

  try {
    const raw = await readFile(filePath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    let events = lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);

    // 过滤
    if (args.type) {
      events = events.filter((e) => e.type === args.type);
    }
    if (typeof args.since === 'number') {
      events = events.filter((e) => e.timestamp >= args.since);
    }

    // 分页
    const offset = Math.max(0, args.offset || 0);
    const limit = args.limit || 1000;
    const sliced = events.slice(offset, offset + limit);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          events: sliced,
          total: events.length,
          offset,
          limit,
          hasMore: offset + limit < events.length,
        }, null, 2),
      }],
    };
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: err.message }),
      }],
      isError: true,
    };
  }
}

/**
 * export_prompt_package
 * 
 * 读取认知事件流和语音转写，调用 prompt-package-compiler 生成 Prompt Package。
 * 
 * 参数：
 *   - events_path?: string     认知事件 JSONL 文件路径
 *   - transcript_path?: string 语音转写文件路径
 *   - screenshot?: string      画布截图 base64 data URI 或 URL（可选，无截图时用占位）
 *   - language?: string        语言代码（默认 "zh-CN"）
 *   - canvas_size?: { width: number, height: number }
 *   - tags?: string[]
 */
async function handleExportPromptPackage(args = {}) {
  const eventsPath = args.events_path || EVENTS_FILE;
  const transcriptPath = args.transcript_path || TRANSCRIPT_FILE;
  const language = args.language || 'zh-CN';
  const canvasSize = args.canvas_size || { width: 1920, height: 1080 };

  // 1. 读取认知事件
  let events = [];
  if (existsSync(eventsPath)) {
    try {
      const raw = await readFile(eventsPath, 'utf-8');
      events = raw
        .split('\n')
        .filter((l) => l.trim())
        .map((line) => {
          try { return JSON.parse(line); }
          catch { return null; }
        })
        .filter(Boolean);
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: `Failed to read events: ${err.message}` }),
        }],
        isError: true,
      };
    }
  }

  // 2. 读取语音转写
  let transcription = '';
  if (existsSync(transcriptPath)) {
    try {
      transcription = await readFile(transcriptPath, 'utf-8');
    } catch {
      transcription = '';
    }
  }

  // 3. 画布截图（无截图时使用占位）
  const screenshot = args.screenshot || `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`;

  // 4. 编译 Prompt Package（内联编译器逻辑，避免依赖 TypeScript 源码）
  try {
    const pkg = compilePromptPackage(events, transcription, screenshot, {
      canvasSize,
      language,
      tags: args.tags,
      userId: args.user_id,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(pkg, null, 2),
      }],
    };
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: `Compilation failed: ${err.message}` }),
      }],
      isError: true,
    };
  }
}

/**
 * get_voice_transcript
 * 
 * 读取语音转写文件，返回文本内容。
 * 
 * 参数：
 *   - path?: string    转写文件路径
 *   - format?: string  返回格式：'text'（默认）| 'segments'
 */
async function handleGetVoiceTranscript(args = {}) {
  const filePath = args.path || TRANSCRIPT_FILE;

  if (!existsSync(filePath)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: `File not found: ${filePath}`,
          hint: 'Set MCP_TRANSCRIPT_FILE env var or pass "path" argument.',
          text: '',
          segments: [],
        }),
      }],
      isError: true,
    };
  }

  try {
    const text = await readFile(filePath, 'utf-8');
    const format = args.format || 'text';

    if (format === 'segments') {
      // 尝试按换行分段
      const segments = text
        .split('\n')
        .filter((l) => l.trim())
        .map((line, i) => ({
          segment_id: `seg_${String(i + 1).padStart(3, '0')}`,
          text: line.trim(),
        }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            full_text: text.trim(),
            segments,
            segment_count: segments.length,
          }, null, 2),
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          text: text.trim(),
          length: text.trim().length,
        }, null, 2),
      }],
    };
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: err.message }),
      }],
      isError: true,
    };
  }
}

// ============================================================
// Inline Prompt Package Compiler
// ============================================================

/**
 * 精简版 Prompt Package 编译器（JS 移植自 TypeScript 源码）。
 * 生成符合 prompt-package-spec v2.0 的结构化 Prompt Package。
 */

function generatePackageId() {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `pp_${ts}_${rand}`;
}

function inferImageFormat(dataUri) {
  if (dataUri.includes('image/webp')) return 'webp';
  if (dataUri.includes('image/jpeg') || dataUri.includes('image/jpg')) return 'jpg';
  return 'png';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const SEMANTIC_TO_STROKE_TYPE = {
  write: 'text',
  draw: 'drawing',
  circle: 'circle',
  highlight: 'highlight',
  cross_out: 'underline',
};

const SEMANTIC_TO_REGION_ROLE = {
  group: 'group',
  circle: 'decision',
};

const SEMANTIC_TO_ARROW_TYPE = {
  connect: 'association',
};

function mapTimelineEventType(eventType) {
  const map = {
    stroke: 'stroke_start',
    region: 'region_create',
    arrow: 'arrow_draw',
    deletion: 'delete',
    pause: 'pause',
  };
  return map[eventType] || 'stroke_start';
}

function inferImportance(event) {
  if (event.type === 'deletion') return 'medium';
  if (event.semanticType === 'cross_out' || event.semanticType === 'erase') return 'medium';
  if (event.semanticType === 'highlight' || event.semanticType === 'circle') return 'high';
  if (event.type === 'pause') return 'low';
  return 'low';
}

function extractStrokes(events) {
  return events
    .filter((e) => e.type === 'stroke')
    .map((e) => {
      const points = Array.isArray(e.data?.points)
        ? e.data.points.map((p) => ({
            x: p[0] ?? 0,
            y: p[1] ?? 0,
            ...(p[2] !== undefined ? { pressure: clamp(p[2], 0, 1) } : {}),
          }))
        : [{ x: e.data?.x ?? 0, y: e.data?.y ?? 0 }];

      return {
        stroke_id: e.shapeId || e.id,
        timestamp_ms: Math.max(0, e.timestamp),
        duration_ms: 0,
        points,
        style: {
          color: e.data?.color ?? '#000000',
          width: typeof e.data?.width === 'number' ? Math.max(0, e.data.width) : 3,
          opacity: 1.0,
        },
        semantic_type: SEMANTIC_TO_STROKE_TYPE[e.semanticType] || undefined,
        recognized_text: typeof e.data?.text === 'string' ? e.data.text : undefined,
        bounding_box: {
          x: e.data?.x ?? 0,
          y: e.data?.y ?? 0,
          width: e.data?.width ?? 0,
          height: e.data?.height ?? 0,
        },
      };
    });
}

function extractRegions(events) {
  return events
    .filter((e) => e.type === 'region')
    .map((e) => ({
      region_id: e.shapeId || e.id,
      timestamp_ms: Math.max(0, e.timestamp),
      bounds: {
        x: e.data?.x ?? 0,
        y: e.data?.y ?? 0,
        width: e.data?.width ?? 0,
        height: e.data?.height ?? 0,
      },
      label: typeof e.data?.text === 'string' ? e.data.text : undefined,
      color: typeof e.data?.color === 'string' ? e.data.color : undefined,
      semantic_role: SEMANTIC_TO_REGION_ROLE[e.semanticType] || undefined,
    }));
}

function extractArrows(events) {
  return events
    .filter((e) => e.type === 'arrow')
    .map((e) => {
      const fromX = e.data?.x ?? 0;
      const fromY = e.data?.y ?? 0;
      const toX = typeof e.data?.toX === 'number' ? e.data.toX : fromX + (e.data?.width ?? 100);
      const toY = typeof e.data?.toY === 'number' ? e.data.toY : fromY;

      return {
        arrow_id: e.shapeId || e.id,
        timestamp_ms: Math.max(0, e.timestamp),
        from: { type: 'point', ref: { x: fromX, y: fromY } },
        to: { type: 'point', ref: { x: toX, y: toY } },
        style: {
          color: e.data?.color ?? '#2196F3',
          width: typeof e.data?.width === 'number' ? Math.max(0, e.data.width) : 2,
          line_style: 'solid',
          arrowhead: 'solid',
        },
        label: typeof e.data?.text === 'string' ? e.data.text : undefined,
        semantic_type: SEMANTIC_TO_ARROW_TYPE[e.semanticType] || undefined,
      };
    });
}

function extractDeletions(events) {
  return events
    .filter((e) => e.type === 'deletion')
    .map((e) => ({
      deletion_id: e.id,
      timestamp_ms: Math.max(0, e.timestamp),
      target_type: 'stroke',
      target_id: e.shapeId,
      method: e.semanticType === 'cross_out' ? 'cross_out' : 'erase',
      reason: typeof e.data?.text === 'string' ? e.data.text : undefined,
    }));
}

function buildTimeline(events) {
  return events.map((e) => ({
    event_id: `evt_${e.id}`,
    timestamp_ms: Math.max(0, e.timestamp),
    event_type: mapTimelineEventType(e.type),
    target_id: e.shapeId || undefined,
    metadata: {
      shapeType: e.shapeType,
      ...(e.semanticType ? { semanticType: e.semanticType } : {}),
    },
    importance: inferImportance(e),
  }));
}

function buildTranscript(transcriptionText, events, language) {
  const trimmed = transcriptionText.trim();
  if (!trimmed) return null;

  const timestamps = events.map((e) => e.timestamp);
  const startTime = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const endTime = timestamps.length > 0 ? Math.max(...timestamps) : 0;

  return {
    full_text: trimmed,
    segments: [{
      segment_id: 'seg_001',
      start_ms: startTime,
      end_ms: endTime,
      text: trimmed,
      confidence: 0.85,
    }],
    language,
  };
}

function extractIntentSummary(events, transcriptionText) {
  const textParts = [];
  for (const e of events) {
    if (typeof e.data?.text === 'string' && e.data.text.trim()) {
      textParts.push(e.data.text.trim());
    }
  }

  const allText = [transcriptionText.trim(), ...textParts].filter(Boolean).join(' ');
  const keyConcepts = [
    ...new Set(
      allText
        .split(/[,，。.!！?？;；\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2 && s.length <= 20)
    ),
  ].slice(0, 10);

  const primaryIntent = transcriptionText.trim()
    ? `基于白板内容的思考：${transcriptionText.trim().slice(0, 50)}${transcriptionText.trim().length > 50 ? '...' : ''}`
    : keyConcepts.length > 0
      ? `白板记录：${keyConcepts.slice(0, 3).join('、')}`
      : '白板创作记录';

  const subIntents = [];
  const hasStrokes = events.some((e) => e.type === 'stroke');
  const hasArrows = events.some((e) => e.type === 'arrow');
  const hasRegions = events.some((e) => e.type === 'region');
  const hasDeletions = events.some((e) => e.type === 'deletion');

  if (hasStrokes) subIntents.push('记录关键信息');
  if (hasRegions) subIntents.push('分组和组织内容');
  if (hasArrows) subIntents.push('建立元素间关系');
  if (hasDeletions) subIntents.push('迭代和修正想法');

  return {
    primary_intent: primaryIntent,
    sub_intents: subIntents.length > 0 ? subIntents : undefined,
    key_concepts: keyConcepts.length > 0 ? keyConcepts : ['白板记录'],
    confidence: transcriptionText.trim() ? 0.75 : 0.5,
    analysis_notes: events.length === 0 ? '没有检测到认知事件' : undefined,
  };
}

function extractObjects(events) {
  const objects = [];

  for (const e of events) {
    if (e.type === 'stroke' && typeof e.data?.text === 'string' && e.data.text.trim()) {
      objects.push({
        object_id: `obj_${e.shapeId || e.id}`,
        type: 'text_block',
        timestamp_ms: Math.max(0, e.timestamp),
        bounds: {
          x: e.data?.x ?? 0,
          y: e.data?.y ?? 0,
          width: e.data?.width ?? 0,
          height: e.data?.height ?? 0,
        },
        properties: { semanticType: e.semanticType },
        source_strokes: [e.shapeId || e.id],
        semantic_content: e.data.text.trim(),
      });
    }

    if (e.type === 'region') {
      objects.push({
        object_id: `obj_${e.shapeId || e.id}`,
        type: 'shape',
        timestamp_ms: Math.max(0, e.timestamp),
        bounds: {
          x: e.data?.x ?? 0,
          y: e.data?.y ?? 0,
          width: e.data?.width ?? 0,
          height: e.data?.height ?? 0,
        },
        properties: {
          shapeType: e.shapeType,
          ...(e.data?.color ? { color: e.data.color } : {}),
        },
        source_strokes: [e.shapeId || e.id],
        semantic_content: typeof e.data?.text === 'string' ? e.data.text : undefined,
      });
    }
  }

  return objects;
}

/**
 * 主编译函数 — 将认知事件流、语音转写、画布截图编译为 Prompt Package
 */
function compilePromptPackage(events, transcription, screenshot, options = {}) {
  const canvasSize = options.canvasSize ?? { width: 1920, height: 1080 };
  const language = options.language ?? 'zh-CN';

  const strokes = extractStrokes(events);
  const regions = extractRegions(events);
  const arrows = extractArrows(events);
  const deletions = extractDeletions(events);
  const timeline = buildTimeline(events);
  const objects = extractObjects(events);
  const transcript = buildTranscript(transcription, events, language);
  const intentSummary = extractIntentSummary(events, transcription);

  const canvasSnapshot = {
    final: {
      url: screenshot,
      format: inferImageFormat(screenshot),
      width: Math.max(1, canvasSize.width),
      height: Math.max(1, canvasSize.height),
    },
  };

  const timestamps = events.map((e) => e.timestamp);
  const durationMs = timestamps.length > 0
    ? Math.max(0, Math.max(...timestamps) - Math.min(...timestamps))
    : 0;

  const meta = {
    package_id: generatePackageId(),
    version: '2.0',
    created_at: new Date().toISOString(),
    duration_ms: durationMs,
    canvas_size: canvasSize,
    ...(options.userId ? { user_id: options.userId } : {}),
    ...(options.tags && options.tags.length > 0 ? { tags: options.tags } : {}),
  };

  const pkg = {
    meta,
    canvas_snapshot: canvasSnapshot,
    strokes,
    ...(regions.length > 0 ? { regions } : {}),
    ...(arrows.length > 0 ? { arrows } : {}),
    ...(deletions.length > 0 ? { deletions } : {}),
    ...(transcript ? { transcript } : { transcript: null }),
    timeline,
    objects,
    intent_summary: intentSummary,
  };

  return pkg;
}

// ============================================================
// MCP Protocol Handler
// ============================================================

const TOOLS = [
  {
    name: 'get_latest_prompt_package',
    description: 'Read the latest Prompt Package exported by the Canvas Prompt sidebar for a project. The package is project-local and contains process context only.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute active project directory. Required when this MCP server was not started from that project.' },
        path: { type: 'string', description: 'Optional absolute replacement path to a Prompt Package JSON file.' },
      },
    },
  },
  {
    name: 'get_cognitive_events',
    description: '读取认知事件流文件（cognitive_events.jsonl），返回事件数组。支持按类型过滤、分页。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'cognitive_events.jsonl 文件路径（默认使用环境变量或项目 data/ 目录）',
        },
        limit: {
          type: 'number',
          description: '最多返回事件数（默认 1000）',
        },
        offset: {
          type: 'number',
          description: '跳过前 N 条事件（默认 0）',
        },
        type: {
          type: 'string',
          description: '按事件类型过滤：stroke|region|arrow|deletion|pause',
          enum: ['stroke', 'region', 'arrow', 'deletion', 'pause', 'move', 'select'],
        },
        since: {
          type: 'number',
          description: '只返回 timestamp >= since 的事件',
        },
      },
    },
  },
  {
    name: 'export_prompt_package',
    description: '编译认知事件流和语音转写为符合 prompt-package-spec v2.0 的 Prompt Package JSON。',
    inputSchema: {
      type: 'object',
      properties: {
        events_path: {
          type: 'string',
          description: '认知事件 JSONL 文件路径',
        },
        transcript_path: {
          type: 'string',
          description: '语音转写文件路径',
        },
        screenshot: {
          type: 'string',
          description: '画布截图 base64 data URI 或 URL（可选）',
        },
        language: {
          type: 'string',
          description: '语言代码（默认 zh-CN）',
        },
        canvas_size: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
          description: '画布尺寸',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '标签列表',
        },
        user_id: {
          type: 'string',
          description: '用户 ID',
        },
      },
    },
  },
  {
    name: 'get_voice_transcript',
    description: '读取语音转写文件，返回转写文本。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '转写文件路径（默认使用环境变量或项目 data/ 目录）',
        },
        format: {
          type: 'string',
          description: '返回格式：text（纯文本）| segments（分段 JSON）',
          enum: ['text', 'segments'],
        },
      },
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
        case 'get_cognitive_events':
          response = await handleGetCognitiveEvents(args);
          break;
        case 'export_prompt_package':
          response = await handleExportPromptPackage(args);
          break;
        case 'get_voice_transcript':
          response = await handleGetVoiceTranscript(args);
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
  const transport = createMessageFramer(
    (req) => {
      handleRequest(req).catch((err) => {
        if (req.id !== undefined) error(req.id, -32603, `Internal error: ${err.message}`);
      });
    },
    () => send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
  );

  process.stdin.on('data', (chunk) => transport.push(chunk));

  process.stdin.on('end', () => {
    process.exit(0);
  });

  process.stderr.write(`[${SERVER_INFO.name}] MCP server started (stdio transport)\n`);
  process.stderr.write(`[${SERVER_INFO.name}] Data dir: ${DATA_DIR}\n`);
  process.stderr.write(`[${SERVER_INFO.name}] Events file: ${EVENTS_FILE}\n`);
  process.stderr.write(`[${SERVER_INFO.name}] Transcript file: ${TRANSCRIPT_FILE}\n`);
}

// ============================================================
// Main
// ============================================================

startServer();
