export function reviewPageScale(pageWidth: number, pageHeight: number, availableWidth: number, availableHeight: number, zoomPercent: number): number {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || !Number.isFinite(pageHeight) || pageHeight <= 0) return 1
  const widthFit = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth / pageWidth : 1
  const heightFit = Number.isFinite(availableHeight) && availableHeight > 0 ? availableHeight / pageHeight : 1
  const fitScale = Math.min(widthFit, heightFit)
  const requestedZoom = Number.isFinite(zoomPercent) ? Math.max(1, zoomPercent) / 100 : 1
  return fitScale * requestedZoom
}

/**
 * Returns a compact outer stage height only when the fitted page is the
 * width-constraining dimension at the implicit 100% zoom baseline. A page
 * that is height-constrained, or explicitly zoomed, keeps the available
 * stage so its scroll surface remains usable.
 */
export function reviewCompactStageHeight(pageHeight: number, stageChromeHeight: number, maxStageHeight: number, zoomPercent: number, minStageHeight = 420): number | null {
  if (!Number.isFinite(pageHeight) || pageHeight <= 0 || !Number.isFinite(stageChromeHeight) || stageChromeHeight < 0 || !Number.isFinite(maxStageHeight) || maxStageHeight <= 0 || zoomPercent !== 100) return null
  const desiredHeight = pageHeight + stageChromeHeight
  if (desiredHeight >= maxStageHeight - 1) return null
  return Math.max(1, Math.min(maxStageHeight, Math.max(minStageHeight, desiredHeight)))
}
