export function reviewPageScale(pageWidth: number, availableWidth: number, zoomPercent: number): number {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0) return 1
  const fitScale = Number.isFinite(availableWidth) && availableWidth > 0
    ? Math.min(1, availableWidth / pageWidth)
    : 1
  const requestedZoom = Number.isFinite(zoomPercent) ? Math.max(1, zoomPercent) / 100 : 1
  return fitScale * requestedZoom
}
