"""PyTorch ASR service — OpenAI Realtime API compatible over WebSocket."""
from __future__ import annotations

import asyncio
import base64
import io
import uuid
import wave
from typing import Any

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

app = FastAPI(title="AI Stack PyTorch ASR", version="0.1.0")

# ── Whisper model (lazy load) ──
_model = None


def get_model():
    global _model
    if _model is None:
        import whisper
        import os

        cache = os.path.expanduser("~/.cache/whisper")
        tiny = os.path.join(cache, "tiny.pt")
        if os.path.exists(tiny):
            _model = whisper.load_model(tiny)
        else:
            _model = whisper.load_model("tiny")
    return _model


def transcribe_pcm(pcm_bytes: bytes, sample_rate: int = 16000) -> str:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    buf.seek(0)
    with wave.open(buf, "rb") as wf:
        audio_data = wf.readframes(wf.getnframes())
    audio = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0
    model = get_model()
    result = model.transcribe(audio, fp16=False, language="zh")
    return result.get("text", "").strip()


# ── REST ──
@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/v1/models")
async def models():
    return {
        "object": "list",
        "data": [{"id": "whisper-tiny", "object": "model", "owned_by": "openai"}],
    }


# ── WebSocket (OpenAI Realtime compatible) ──
@app.websocket("/v1/realtime")
async def realtime(ws: WebSocket):
    await ws.accept()
    session_id = f"session_{uuid.uuid4().hex}"
    await ws.send_json({
        "type": "session.created",
        "session": {
            "id": session_id,
            "object": "realtime.session",
            "modalities": ["text"],
            "input_audio_format": {"type": "pcm16", "rate": 16000},
        },
    })
    buffer = bytearray()
    sample_rate = 16000

    try:
        while True:
            msg = await ws.receive_json()
            etype = msg.get("type")

            if etype == "session.update":
                cfg = msg.get("session", {})
                sample_rate = cfg.get("input_audio_format", {}).get("rate", sample_rate)
                await ws.send_json({
                    "type": "session.updated",
                    "session": {
                        "id": session_id,
                        "modalities": ["text"],
                        "input_audio_format": {"type": "pcm16", "rate": sample_rate},
                    },
                })

            elif etype == "input_audio_buffer.append":
                audio_b64 = msg.get("audio", "")
                if audio_b64:
                    buffer.extend(base64.b64decode(audio_b64))
                await ws.send_json({"type": "input_audio_buffer.status"})

            elif etype == "input_audio_buffer.commit":
                text = await asyncio.to_thread(
                    transcribe_pcm, bytes(buffer), sample_rate
                )
                buffer.clear()
                item_id = f"item_{uuid.uuid4().hex}"
                await ws.send_json({
                    "type": "conversation.item.created",
                    "item": {
                        "id": item_id,
                        "object": "realtime.item",
                        "type": "message",
                        "status": "completed",
                        "role": "user",
                        "content": [{"type": "input_audio", "transcript": text}],
                    },
                })
                await ws.send_json({
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": item_id,
                    "content_index": 0,
                    "transcript": text,
                })

            elif etype == "input_audio_buffer.clear":
                buffer.clear()
                await ws.send_json({"type": "input_audio_buffer.cleared"})

            else:
                await ws.send_json({
                    "type": "error",
                    "error": {
                        "type": "invalid_request_error",
                        "message": f"Unknown event: {etype}",
                    },
                })
    except WebSocketDisconnect:
        pass


@app.websocket("/ws/realtime")
async def realtime_legacy(ws: WebSocket):
    await realtime(ws)
