import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import PdfReviewSpike from './PdfReviewSpike'
import { resolveInitialLocale, saveLocalePreference } from './locale'
import type { Locale } from './locale'
import { captureSwitchBlockMessage } from './capture-session-gate'
import './styles.css'
import '@excalidraw/excalidraw/index.css'

const root = ReactDOM.createRoot(document.getElementById('root')!)

function CanvasPromptRoot() {
  const [locale, setLocale] = useState<Locale>(() => resolveInitialLocale(window.localStorage, window.navigator.languages, window.navigator.language))
  const [artifactReviewFile, setArtifactReviewFile] = useState<File | null>(null)
  const [artifactReviewOpen, setArtifactReviewOpen] = useState(
    () => new URLSearchParams(window.location.search).get('artifact-review-spike') === '1',
  )
  const [canvasCaptureBusy, setCanvasCaptureBusy] = useState(false)
  const [artifactCaptureBusy, setArtifactCaptureBusy] = useState(false)
  const [captureNotice, setCaptureNotice] = useState<string | null>(null)

  const openArtifactReview = (file?: File, currentCaptureBusy = canvasCaptureBusy) => {
    const blocked = captureSwitchBlockMessage('canvas', currentCaptureBusy || canvasCaptureBusy, locale)
    if (blocked) {
      setCaptureNotice(blocked)
      return
    }
    setCaptureNotice(null)
    window.history.replaceState(null, '', `${window.location.pathname}?artifact-review-spike=1`)
    if (file) setArtifactReviewFile(file)
    setArtifactReviewOpen(true)
  }

  const returnToCanvas = (currentCaptureBusy = artifactCaptureBusy) => {
    const blocked = captureSwitchBlockMessage('artifact-review', currentCaptureBusy || artifactCaptureBusy, locale)
    if (blocked) {
      setCaptureNotice(blocked)
      return
    }
    setCaptureNotice(null)
    window.history.replaceState(null, '', window.location.pathname)
    setArtifactReviewOpen(false)
  }

  const changeLocale = (next: Locale) => {
    saveLocalePreference(window.localStorage, next)
    setLocale(next)
  }

  useEffect(() => {
    if (!canvasCaptureBusy && !artifactCaptureBusy) setCaptureNotice(null)
  }, [artifactCaptureBusy, canvasCaptureBusy])

  return <>
    {captureNotice && <div className="capture-session-notice" role="alert">{captureNotice}</div>}
    <div hidden={artifactReviewOpen} aria-hidden={artifactReviewOpen}>
      <App locale={locale} onLocaleChange={changeLocale} onOpenArtifactReview={openArtifactReview} onCaptureStateChange={setCanvasCaptureBusy} />
    </div>
    <div hidden={!artifactReviewOpen} aria-hidden={!artifactReviewOpen}>
      <PdfReviewSpike active={artifactReviewOpen} locale={locale} onLocaleChange={changeLocale} initialFile={artifactReviewFile ?? undefined} onReturnToCanvas={returnToCanvas} onCaptureStateChange={setArtifactCaptureBusy} />
    </div>
  </>
}

root.render(
  <React.StrictMode><CanvasPromptRoot /></React.StrictMode>,
)
