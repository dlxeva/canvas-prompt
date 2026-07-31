import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import PdfReviewSpike from './PdfReviewSpike'
import './styles.css'
import '@excalidraw/excalidraw/index.css'

const root = ReactDOM.createRoot(document.getElementById('root')!)
const artifactReviewSpike = new URLSearchParams(window.location.search).get('artifact-review-spike') === '1'

root.render(
  <React.StrictMode>{artifactReviewSpike ? <PdfReviewSpike /> : <App />}</React.StrictMode>,
)
