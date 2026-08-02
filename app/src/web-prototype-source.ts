export const MAX_WEB_PROTOTYPE_BYTES = 32 * 1024 * 1024

export type WebPrototypeSource = {
  name: string
  entryPath: string
  sourceHash: string
  srcDoc: string
  assetUrls: string[]
}

const normalizePath = (value: string) => value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '')

function preferredEntry(files: File[]) {
  const htmlFiles = files.filter((file) => /\.html?$/i.test(file.name))
  if (htmlFiles.length === 0) throw new Error('请选择 HTML 文件，或包含 index.html 的网页文件夹。')
  return [...htmlFiles].sort((left, right) => {
    const leftPath = normalizePath(left.webkitRelativePath || left.name)
    const rightPath = normalizePath(right.webkitRelativePath || right.name)
    const leftIndex = /(^|\/)index\.html?$/i.test(leftPath) ? 0 : 1
    const rightIndex = /(^|\/)index\.html?$/i.test(rightPath) ? 0 : 1
    return leftIndex - rightIndex || leftPath.split('/').length - rightPath.split('/').length || leftPath.localeCompare(rightPath)
  })[0]
}

function relativeToEntry(file: File, entryPath: string) {
  const path = normalizePath(file.webkitRelativePath || file.name)
  const entryParts = entryPath.split('/')
  entryParts.pop()
  const prefix = entryParts.length > 0 ? `${entryParts.join('/')}/` : ''
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function escapeScript(value: string) {
  return value.replaceAll('</script', '<\\/script')
}

export function interactionCaptureRuntime() {
  return escapeScript(`
(() => {
  const CHANNEL = 'canvas-prompt-interaction-review-v1';
  let startedAt = 0;
  const now = () => startedAt ? Math.max(0, Date.now() - startedAt) : 0;
  const sensitive = (element) => element instanceof HTMLInputElement && (
    ['password', 'email', 'tel'].includes(element.type) || element.matches('[data-sensitive="true"]')
  );
  const clipped = (value, length = 120) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, length);
  const stableId = (element) => {
    if (!(element instanceof Element)) return null;
    const declared = element.getAttribute('data-element-id') || element.getAttribute('data-testid') || element.id;
    if (declared) return declared;
    const role = element.getAttribute('role') || element.tagName.toLowerCase();
    const label = clipped(element.getAttribute('aria-label') || element.textContent, 48).toLowerCase().replace(/[^a-z0-9\\u4e00-\\u9fff]+/g, '-').replace(/^-|-$/g, '');
    const siblings = element.parentElement ? [...element.parentElement.children].filter((item) => item.tagName === element.tagName) : [];
    const position = siblings.length > 1 ? '-' + (siblings.indexOf(element) + 1) : '';
    return label ? role + '-' + label + position : role + position;
  };
  const route = () => location.hash || document.body?.getAttribute('data-route') || '/';
  const state = () => ({ route: route(), title: clipped(document.title, 100), scroll_x: Math.max(0, Math.round(scrollX)), scroll_y: Math.max(0, Math.round(scrollY)) });
  const target = (element) => {
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    return {
      element_id: stableId(element),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || null,
      label: clipped(element.getAttribute('aria-label') || element.textContent, 120),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
  };
  const emit = (kind, element, detail = {}) => {
    parent.postMessage({ channel: CHANNEL, kind, at_ms: now(), route: route(), viewport: { width: innerWidth, height: innerHeight, scroll_x: Math.max(0, Math.round(scrollX)), scroll_y: Math.max(0, Math.round(scrollY)) }, target: target(element), state: state(), detail }, '*');
  };
  addEventListener('message', (event) => {
    if (event.data?.channel !== CHANNEL || event.data?.command !== 'start') return;
    startedAt = Date.now() - Math.max(0, Number(event.data.elapsed_ms) || 0);
    emit('session_started', document.body);
  });
  addEventListener('click', (event) => emit('click', event.target), true);
  addEventListener('input', (event) => {
    const element = event.target;
    emit('input', element, sensitive(element) ? { privacy: 'excluded', excluded_reason: 'sensitive-field' } : { privacy: 'metadata-only', value_length: typeof element?.value === 'string' ? element.value.length : 0 });
  }, true);
  let scrollTimer = 0;
  addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => emit('scroll', document.scrollingElement), 180); }, true);
  addEventListener('hashchange', () => emit('navigate', document.body));
  addEventListener('popstate', () => emit('navigate', document.body));
  parent.postMessage({ channel: CHANNEL, kind: 'runtime_ready', at_ms: 0, route: route(), viewport: { width: innerWidth, height: innerHeight, scroll_x: 0, scroll_y: 0 }, target: null, state: state(), detail: {} }, '*');
})();`)
}

function injectRuntime(html: string) {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data: blob:; style-src 'unsafe-inline' data: blob:; script-src 'unsafe-inline' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'">`
  const runtime = `<script>${interactionCaptureRuntime()}</script>`
  const withPolicy = /<head[\s>]/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${policy}`) : `${policy}${html}`
  return /<\/body>/i.test(withPolicy) ? withPolicy.replace(/<\/body>/i, `${runtime}</body>`) : `${withPolicy}${runtime}`
}

function rewriteDirectAssets(html: string, assets: Map<string, string>) {
  return html.replace(/\b(src|href)=(['"])([^'"#][^'"]*)\2/gi, (match, attribute: string, quote: string, rawPath: string) => {
    if (/^(?:[a-z]+:|\/\/|data:|blob:)/i.test(rawPath)) return match
    const cleanPath = normalizePath(rawPath.split(/[?#]/, 1)[0])
    const url = assets.get(cleanPath)
    return url ? `${attribute}=${quote}${url}${quote}` : match
  })
}

export async function prepareWebPrototypeSource(filesInput: File[] | FileList): Promise<WebPrototypeSource> {
  const files = Array.from(filesInput)
  if (files.length === 0) throw new Error('没有选择网页文件。')
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > MAX_WEB_PROTOTYPE_BYTES) throw new Error('网页原型超过 32MB，请先导出精简的静态预览版本。')
  const entry = preferredEntry(files)
  const entryPath = normalizePath(entry.webkitRelativePath || entry.name)
  const assetUrls: string[] = []
  const assetMap = new Map<string, string>()
  for (const file of files) {
    if (file === entry || /\.html?$/i.test(file.name)) continue
    const relativePath = relativeToEntry(file, entryPath)
    const url = URL.createObjectURL(file)
    assetUrls.push(url)
    assetMap.set(relativePath, url)
  }
  const html = await entry.text()
  const digestInput = new Uint8Array(await entry.arrayBuffer())
  const hash = await crypto.subtle.digest('SHA-256', digestInput)
  const sourceHash = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return {
    name: entry.name,
    entryPath,
    sourceHash,
    srcDoc: injectRuntime(rewriteDirectAssets(html, assetMap)),
    assetUrls,
  }
}

export function releaseWebPrototypeSource(source: WebPrototypeSource | null | undefined) {
  source?.assetUrls.forEach((url) => URL.revokeObjectURL(url))
}
