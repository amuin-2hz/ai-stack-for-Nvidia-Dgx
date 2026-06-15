"""Realtime audio service entrypoint  — OpenAI Realtime API compatible over WebSocket."""

from __future__ import annotations

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from config import settings
from protocol import make_event
from service import AudioSession, RealtimeAudioService


service = RealtimeAudioService()
app = FastAPI(
    title="Chatbot Spark Audio Service",
    description="OpenAI Realtime API compatible streaming ASR/TTS service",
    version="0.1.0",
)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/models")
async def models() -> dict[str, object]:
    return {
        "object": "list",
        "data": [
            {
                "id": settings.asr_model,
                "object": "model",
                "owned_by": "FunAudioLLM",
            },
            {
                "id": settings.tts_model,
                "object": "model",
                "owned_by": "FunAudioLLM",
            },
        ],
    }


@app.websocket("/v1/realtime")
async def realtime_openai(websocket: WebSocket) -> None:
    """OpenAI Realtime API compatible endpoint."""
    await websocket.accept()
    session = AudioSession()
    await websocket.send_json(
        make_event(
            "session.created",
            session={
                "id": session.session_id,
                "object": "realtime.session",
                "modalities": session.modalities,
                "voice": session.voice,
                "input_audio_format": {"type": "pcm16", "rate": session.input_sample_rate},
                "output_audio_format": {"type": "pcm16", "rate": session.output_sample_rate},
                "turn_detection": session.turn_detection,
                "temperature": 0.8,
                "max_response_output_tokens": "inf",
            },
        )
    )

    try:
        while True:
            payload = await websocket.receive_json()
            responses = await service.handle_event(session, payload)
            for event in responses:
                await websocket.send_json(event)
    except WebSocketDisconnect:
        return


@app.websocket("/ws/realtime")
async def realtime_legacy(websocket: WebSocket) -> None:
    """Legacy websocket endpoint (same as /v1/realtime)."""
    await realtime_openai(websocket)
