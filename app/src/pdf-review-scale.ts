export function reviewPageScale(pageWidth: number, pageHeight: number, availableWidth: number, availableHeight: number, zoomPercent: number): number {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || !Number.isFinite(pageHeight) || pageHeight <= 0) return 1
  const widthFit = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth / pageWidth : 1
  const heightFit = Number.isFinite(availableHeight) && availableHeight > 0 ? availableHeight / pageHeight : 1
  const fitScale = Math.min(widthFit, heightFit)
  const requestedZoom = Number.isFinite(zoomPercent) ? Math.max(1, zoomPercent) / 100 : 1
  return fitScale * requestedZoom
}
