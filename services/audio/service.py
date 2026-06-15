"""Realtime audio session orchestration  — OpenAI Realtime API compatible."""

from __future__ import annotations

import base64
import uuid
from dataclasses import dataclass, field
from typing import Any

from adapters.base import AudioChunk, TranscriptChunk
from adapters.cosyvoice_adapter import CosyVoiceAdapter
from adapters.funasr_adapter import FunASRAdapter
from protocol import encode_audio_chunk, make_event


@dataclass
class AudioSession:
    session_id: str = field(default_factory=lambda: f"session_{uuid.uuid4().hex}")
    turn_detection: dict[str, Any] | None = field(default_factory=lambda: {"type": "server_vad"})
    input_sample_rate: int = 16000
    output_sample_rate: int = 22050
    modalities: list[str] = field(default_factory=lambda: ["text", "audio"])
    voice: str = "alloy"


class RealtimeAudioService:
    def __init__(self) -> None:
        self.asr = FunASRAdapter()
        self.tts = CosyVoiceAdapter()

    async def handle_event(self, session: AudioSession, event: dict[str, Any]) -> list[dict[str, Any]]:
        event_type = event.get("type")
        if event_type == "session.update":
            session_cfg = event.get("session", {})
            session.turn_detection = session_cfg.get("turn_detection", session.turn_detection)
            session.input_sample_rate = session_cfg.get("input_audio_format", {}).get("sample_rate", session.input_sample_rate)
            session.output_sample_rate = session_cfg.get("output_audio_format", {}).get("sample_rate", session.output_sample_rate)
            session.modalities = session_cfg.get("modalities", session.modalities)
            session.voice = session_cfg.get("voice", session.voice)
            return [
                make_event(
                    "session.updated",
                    session={
                        "id": session.session_id,
                        "object": "realtime.session",
                        "modalities": session.modalities,
                        "voice": session.voice,
                        "turn_detection": session.turn_detection,
                        "input_audio_format": {"type": "pcm16", "rate": session.input_sample_rate},
                        "output_audio_format": {"type": "pcm16", "rate": session.output_sample_rate},
                    },
                )
            ]

        if event_type == "input_audio_buffer.append":
            audio_b64 = event.get("audio", "")
            if audio_b64:
                audio_bytes = base64.b64decode(audio_b64)
                await self.asr.push_audio(audio_bytes)
            return [make_event("input_audio_buffer.status", item_id=None)]

        if event_type == "input_audio_buffer.commit":
            results = await self.asr.flush()
            return self._transcript_events(session, results)

        if event_type == "input_audio_buffer.clear":
            self.asr._buffer.clear()
            return [make_event("input_audio_buffer.cleared")]

        if event_type == "response.create":
            response_cfg = event.get("response", {})
            text = response_cfg.get("instructions") or response_cfg.get("text") or ""
            voice = response_cfg.get("voice", session.voice)
            if not text:
                return [make_event("error", error={"type": "invalid_request_error", "message": "response.create requires instructions or text"})]
            audio_chunks = await self.tts.synthesize(text, voice=voice)
            return self._audio_events(audio_chunks, response_text=text)

        if event_type == "response.cancel":
            return [make_event("response.cancelled")]

        return [make_event("error", error={"type": "invalid_request_error", "message": f"Unsupported event type: {event_type}"})]

    def _transcript_events(self, session: AudioSession, results: list[TranscriptChunk]) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = [
            make_event(
                "conversation.item.created",
                item={
                    "id": f"item_{uuid.uuid4().hex}",
                    "object": "realtime.item",
                    "type": "message",
                    "status": "completed",
                    "role": "user",
                    "content": [{"type": "input_audio", "transcript": None}],
                },
            )
        ]
        for chunk in results:
            if not chunk.text:
                continue
            events.append(
                make_event(
                    "conversation.item.input_audio_transcription.completed",
                    item_id=events[0]["item"]["id"],
                    content_index=0,
                    transcript=chunk.text,
                )
            )
        if len(events) == 1:
            events.append(
                make_event(
                    "conversation.item.input_audio_transcription.completed",
                    item_id=events[0]["item"]["id"],
                    content_index=0,
                    transcript="",
                )
            )
        return events

    def _audio_events(self, chunks: list[AudioChunk], response_text: str) -> list[dict[str, Any]]:
        response_id = f"resp_{uuid.uuid4().hex}"
        events: list[dict[str, Any]] = [
            make_event(
                "response.created",
                response={
                    "id": response_id,
                    "object": "realtime.response",
                    "status": "in_progress",
                    "output": [],
                },
            ),
            make_event(
                "response.text.delta",
                response_id=response_id,
                delta=response_text,
            ),
            make_event(
                "response.text.done",
                response_id=response_id,
                text=response_text,
            ),
        ]
        for chunk in chunks:
            events.append(
                make_event(
                    "response.audio.delta",
                    response_id=response_id,
                    delta=encode_audio_chunk(chunk.audio_bytes),
                )
            )
        events.append(
            make_event(
                "response.audio.done",
                response_id=response_id,
            )
        )
        events.append(
            make_event(
                "response.done",
                response={
                    "id": response_id,
                    "object": "realtime.response",
                    "status": "completed",
                    "output": [
                        {"type": "text", "text": response_text},
                        {"type": "audio", "transcript": response_text},
                    ],
                },
            )
        )
        return events
