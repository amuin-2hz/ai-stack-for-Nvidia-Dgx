"""TTS adapter using Microsoft Edge TTS (edge-tts) for reliable synthesis."""

from __future__ import annotations

import asyncio
from typing import Iterable

from adapters.base import AudioChunk
from config import settings

VOICE_MAP: dict[str, str] = {
    "alloy": "zh-CN-XiaoxiaoNeural",   # 标准女声
    "nova": "zh-CN-XiaoyiNeural",     # 清脆女声
    "shimmer": "zh-CN-YunxiNeural",   # 男声
}


class CosyVoiceAdapter:
    def __init__(self) -> None:
        self._model = None
        self._init_error: str | None = None

    def _ensure_model(self) -> None:
        if self._model is not None or self._init_error is not None:
            return
        try:
            import edge_tts
            self._model = True  # edge-tts doesn't need a persistent model
        except ImportError as exc:
            self._init_error = f"edge-tts not installed: {exc}"
            raise
        except Exception as exc:
            self._init_error = str(exc)
            raise

    async def synthesize(self, text: str, voice: str = "alloy") -> Iterable[AudioChunk]:
        import edge_tts

        self._ensure_model()
        edge_voice = VOICE_MAP.get(voice, VOICE_MAP["alloy"])

        pcm_parts: list[bytearray] = []
        communicate = edge_tts.Communicate(text, edge_voice)

        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                pcm_parts.append(bytearray(chunk["data"]))

        all_pcm = b"".join(pcm_parts)
        return self._chunk_audio(all_pcm)

    def _chunk_audio(self, pcm_bytes: bytes, chunk_size: int = 4096) -> list[AudioChunk]:
        chunks: list[AudioChunk] = []
        for start in range(0, len(pcm_bytes), chunk_size):
            end = start + chunk_size
            chunks.append(
                AudioChunk(
                    audio_bytes=pcm_bytes[start:end],
                    sample_rate=settings.tts_sample_rate,
                    is_final=end >= len(pcm_bytes),
                )
            )
        if not chunks:
            chunks.append(
                AudioChunk(audio_bytes=b"", sample_rate=settings.tts_sample_rate, is_final=True)
            )
        return chunks
