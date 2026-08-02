import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const runCommand = promisify(execFile)

export const DEFAULT_MAX_PPTX_BYTES = 64 * 1024 * 1024
export const DEFAULT_PPTX_CONVERSION_TIMEOUT_MS = 30_000

export type PptxReviewConversion = {
  pdfBytes: Buffer
  sourceSha256: string
  renderSha256: string
  renderer: {
    name: 'LibreOffice'
    version?: string
  }
}

type ConvertOptions = {
  sofficePath?: string
  fontconfigFile?: string | false
  maxBytes?: number
  timeoutMs?: number
  temporaryRoot?: string
}

const MACOS_FONTCONFIG_CANDIDATES = [
  '/opt/homebrew/etc/fonts/fonts.conf',
  '/usr/local/etc/fonts/fonts.conf',
]

function resolveFontconfigFile(configured: string | false | undefined) {
  if (configured === false) return undefined
  if (configured) return configured
  if (process.env.CANVAS_PROMPT_FONTCONFIG_FILE) return process.env.CANVAS_PROMPT_FONTCONFIG_FILE
  if (process.platform !== 'darwin') return undefined
  return MACOS_FONTCONFIG_CANDIDATES.find((candidate) => existsSync(candidate))
}

function rendererEnvironment(fontconfigFile: string | undefined) {
  if (!fontconfigFile) return process.env
  return {
    ...process.env,
    FONTCONFIG_FILE: fontconfigFile,
    FONTCONFIG_PATH: dirname(fontconfigFile),
  }
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function hasZipSignature(bytes: Uint8Array) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

function validatePptxContainer(bytes: Uint8Array) {
  if (!hasZipSignature(bytes)) throw new Error('文件不是有效的 PPTX 容器。')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const minimumEocdOffset = Math.max(0, bytes.byteLength - 65_557)
  let eocdOffset = -1
  for (let offset = bytes.byteLength - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset < 0) throw new Error('PPTX ZIP 目录损坏。')

  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true)
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true)
  if (
    entryCount === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
    || centralDirectoryOffset + centralDirectorySize > eocdOffset
  ) throw new Error('PPTX ZIP 目录损坏。')

  const entryNames = new Set<string>()
  let cursor = centralDirectoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocdOffset || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error('PPTX ZIP 目录损坏。')
    }
    const flags = view.getUint16(cursor + 8, true)
    if ((flags & 0x0001) !== 0) throw new Error('PPTX 文件已加密，当前无法进行交互审阅。')
    const fileNameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const nextCursor = cursor + 46 + fileNameLength + extraLength + commentLength
    if (nextCursor > eocdOffset) throw new Error('PPTX ZIP 目录损坏。')
    entryNames.add(Buffer.from(bytes.subarray(cursor + 46, cursor + 46 + fileNameLength)).toString('utf8'))
    cursor = nextCursor
  }
  if (cursor !== centralDirectoryOffset + centralDirectorySize) throw new Error('PPTX ZIP 目录损坏。')
  if (!entryNames.has('[Content_Types].xml') || !entryNames.has('ppt/presentation.xml')) {
    throw new Error('ZIP 容器不包含有效的 PPTX 结构。')
  }
  if (![...entryNames].some((name) => /^ppt\/slides\/slide[1-9]\d*\.xml$/.test(name))) {
    throw new Error('PPTX 不包含可审阅页面。')
  }
}

async function rendererVersion(sofficePath: string, timeoutMs: number) {
  try {
    const { stdout } = await runCommand(sofficePath, ['--version'], {
      timeout: Math.min(timeoutMs, 5_000),
      maxBuffer: 256 * 1024,
    })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

function normalizeRendererFailure(error: unknown) {
  if (error && typeof error === 'object') {
    const code = 'code' in error ? error.code : undefined
    const signal = 'signal' in error ? error.signal : undefined
    const killed = 'killed' in error && error.killed === true
    if (code === 'ENOENT') return new Error('PPTX 本地渲染器不可用。')
    if (code === 'ETIMEDOUT' || signal === 'SIGTERM' || killed) return new Error('PPTX 本地转换超时。')
  }
  return new Error('PPTX 本地转换失败。')
}

/**
 * Converts source bytes only inside an isolated temporary directory.
 * The caller receives PDF bytes and hashes; source paths never cross the API.
 */
export async function convertPptxForReview(
  sourceBytes: Uint8Array,
  {
    sofficePath = process.env.CANVAS_PROMPT_SOFFICE_BIN || 'soffice',
    fontconfigFile,
    maxBytes = DEFAULT_MAX_PPTX_BYTES,
    timeoutMs = DEFAULT_PPTX_CONVERSION_TIMEOUT_MS,
    temporaryRoot = tmpdir(),
  }: ConvertOptions = {},
): Promise<PptxReviewConversion> {
  if (sourceBytes.byteLength === 0) throw new Error('PPTX 文件为空。')
  if (sourceBytes.byteLength > maxBytes) throw new Error(`PPTX 文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制。`)
  validatePptxContainer(sourceBytes)

  const workDir = await mkdtemp(join(temporaryRoot, 'canvas-prompt-pptx-'))
  const sourcePath = join(workDir, 'source.pptx')
  const profilePath = join(workDir, 'profile')
  const expectedPdfPath = join(workDir, 'source.pdf')
  const resolvedFontconfigFile = resolveFontconfigFile(fontconfigFile)
  try {
    await writeFile(sourcePath, sourceBytes)
    try {
      await runCommand(sofficePath, [
        '--headless',
        `-env:UserInstallation=${pathToFileURL(profilePath).href}`,
        '--convert-to',
        'pdf',
        '--outdir',
        workDir,
        sourcePath,
      ], {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: rendererEnvironment(resolvedFontconfigFile),
      })
    } catch (error) {
      throw normalizeRendererFailure(error)
    }
    const pdfBytes = await readFile(expectedPdfPath).catch(() => {
      throw new Error(`PPTX 转换未生成 ${basename(expectedPdfPath)}。`)
    })
    if (pdfBytes.length < 5 || pdfBytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('PPTX 转换结果不是有效 PDF。')
    }
    return {
      pdfBytes,
      sourceSha256: sha256(sourceBytes),
      renderSha256: sha256(pdfBytes),
      renderer: {
        name: 'LibreOffice',
        version: await rendererVersion(sofficePath, timeoutMs),
      },
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
