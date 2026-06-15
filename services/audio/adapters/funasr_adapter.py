"""FunASR adapter using Whisper for reliable ASR."""

from __future__ import annotations

import asyncio
import io
import wave
from typing import Iterable

import numpy as np

from adapters.base import TranscriptChunk
from config import settings


class FunASRAdapter:
    def __init__(self) -> None:
        self._buffer = bytearray()
        self._model = None
        self._init_error: str | None = None

    def _ensure_model(self) -> None:
        if self._model is not None or self._init_error is not None:
            return
        try:
            import whisper
            import os
            cache_dir = os.path.expanduser("~/.cache/whisper")
            tiny_path = os.path.join(cache_dir, "tiny.pt")
            tiny_en_path = os.path.join(cache_dir, "tiny.en.pt")
            # Prefer multilingual tiny for Chinese support
            if os.path.exists(tiny_path):
                self._model = whisper.load_model(tiny_path)
            elif os.path.exists(tiny_en_path):
                self._model = whisper.load_model(tiny_en_path)
            else:
                self._model = whisper.load_model("tiny")
        except Exception as exc:
            self._init_error = str(exc)
            raise

    async def push_audio(self, audio_bytes: bytes) -> Iterable[TranscriptChunk]:
        self._buffer.extend(audio_bytes)
        return []

    async def flush(self) -> Iterable[TranscriptChunk]:
        if not self._buffer:
            return [TranscriptChunk(text="", is_final=True)]

        self._ensure_model()
        payload = bytes(self._buffer)
        self._buffer.clear()

        text = await asyncio.to_thread(self._run_inference, payload)
        return [TranscriptChunk(text=text, is_final=True)]

    def _run_inference(self, pcm_bytes: bytes) -> str:
        # Write PCM16 to WAV in memory
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(settings.asr_sample_rate)
            wf.writeframes(pcm_bytes)
        buf.seek(0)

        # Load audio as numpy array
        with wave.open(buf, "rb") as wf:
            audio_data = wf.readframes(wf.getnframes())
        audio = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0

        result = self._model.transcribe(audio, fp16=False, language="zh")
        return result.get("text", "").strip()
