# OCR experiment (opt-in)

The default Canvas Prompt app has no OCR, Paddle, OpenCV, or ONNX runtime
dependency. The mainline observation and normalization contract remains in
`app/src/local-ocr.ts`, but no engine is registered by default.

This directory is an isolated experiment only. Its `package.json` is not a
workspace dependency and is not installed by the root or `app` package. If the
experiment is explicitly resumed, install its dependencies in this directory
and choose a cache directory with sufficient space; do not add it back to the
default app graph. The optional package owns runner registration and
`recognizeCanvasText()`; the default app only owns the observation normalizer.

Run the research smoke with:

```sh
cd research/ocr
npm install --ignore-scripts
npm run dev
```

The smoke registers PaddleOCR only inside this package and emits the same
normalized observation contract as the mainline adapter.

The experiment does not change App, Prompt Package, API, MCP, Python, or launch
contracts.
