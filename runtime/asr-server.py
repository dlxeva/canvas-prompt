#!/usr/bin/env python3
"""Canvas Prompt's project-independent local ASR service.

This service is intentionally small: it exposes only the browser contract used
by Canvas Prompt and listens on loopback.  It does not inspect Canvas Prompt
archives, browser tabs, or any host-agent state.
"""

from __future__ import annotations

import argparse
import os
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
from faster_whisper import WhisperModel


app = FastAPI(title="Canvas Prompt local ASR", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(127\\.0\\.0\\.1|localhost):[0-9]+$",
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

model: WhisperModel | None = None
model_name = "base"
device = "auto"
compute_type = "auto"


@app.on_event("startup")
async def load_model() -> None:
    global model
    # faster-whisper downloads its selected model into the local user cache on
    # first use.  That cost is intentionally visible to the launcher.
    model = WhisperModel(model_name, device=device, compute_type=compute_type)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok" if model is not None else "starting",
        "backend": "faster-whisper",
        "whisper_loaded": model is not None,
        "canvas_prompt_asr": True,
        "model": model_name,
    }


def temporary_suffix(upload: UploadFile) -> str:
    filename = upload.filename or "audio.webm"
    suffix = Path(filename).suffix.lower()
    return suffix if suffix in {".webm", ".ogg", ".wav", ".mp3", ".m4a", ".mp4"} else ".webm"


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    language: str | None = Form(default=None),
) -> JSONResponse:
    if model is None:
        raise HTTPException(status_code=503, detail="Canvas Prompt ASR is still starting")
    source = await audio.read()
    if not source:
        raise HTTPException(status_code=400, detail="No audio bytes received")
    descriptor = tempfile.NamedTemporaryFile(suffix=temporary_suffix(audio), delete=False)
    try:
        descriptor.write(source)
        descriptor.close()
        segments_iter, info = model.transcribe(
            descriptor.name,
            language=language or None,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
        )
        segments = []
        for segment in segments_iter:
            text = segment.text.strip()
            if text:
                segments.append({
                    "start": round(segment.start, 3),
                    "end": round(segment.end, 3),
                    "text": text,
                    "confidence": 0.8,
                })
        return JSONResponse({
            "text": " ".join(segment["text"] for segment in segments),
            "segments": segments,
            "language": info.language,
            "duration": round(info.duration, 3),
        })
    except HTTPException:
        raise
    except Exception as error:  # noqa: BLE001 - return a local API error, never an archive fallback
        raise HTTPException(status_code=500, detail=f"Local ASR failed: {error}") from error
    finally:
        try:
            os.unlink(descriptor.name)
        except FileNotFoundError:
            pass


def main() -> None:
    global model_name, device, compute_type
    parser = argparse.ArgumentParser(description="Canvas Prompt local ASR service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--model", default=os.environ.get("CANVAS_PROMPT_ASR_MODEL", "base"))
    parser.add_argument("--device", default=os.environ.get("CANVAS_PROMPT_ASR_DEVICE", "auto"))
    parser.add_argument("--compute-type", default=os.environ.get("CANVAS_PROMPT_ASR_COMPUTE_TYPE", "auto"))
    args = parser.parse_args()
    model_name, device, compute_type = args.model, args.device, args.compute_type
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
