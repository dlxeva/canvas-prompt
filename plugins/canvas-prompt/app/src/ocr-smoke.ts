import { recognizeCanvasText } from './local-ocr'

const output = document.querySelector<HTMLPreElement>('#result')
const run = document.querySelector<HTMLButtonElement>('#run')

if (!output || !run) throw new Error('OCR smoke test DOM is incomplete')

async function rasterizeSvg(): Promise<Blob> {
  const svg = await fetch('/ocr-smoke.svg').then((response) => {
    if (!response.ok) throw new Error(`sample fetch failed: ${response.status}`)
    return response.blob()
  })
  const url = URL.createObjectURL(svg)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('sample SVG could not be rendered'))
      image.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    canvas.getContext('2d')?.drawImage(image, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('sample PNG could not be encoded')), 'image/png')
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

run.addEventListener('click', async () => {
  run.disabled = true
  output.textContent = '正在加载本机 OCR 模型并识别固定中文样图…'
  try {
    const image = await rasterizeSvg()
    const result = await recognizeCanvasText(image)
    output.textContent = JSON.stringify(result, null, 2)
  } catch (error) {
    output.textContent = `OCR smoke failed: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    run.disabled = false
  }
})

