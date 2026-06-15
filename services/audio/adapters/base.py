"""Adapter interfaces for pluggable ASR and TTS runtimes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Protocol


@dataclass
class TranscriptChunk:
    text: str
    is_final: bool = False


@dataclass
class AudioChunk:
    audio_bytes: bytes
    sample_rate: int = 22050
    is_final: bool = False


class StreamingAsrAdapter(Protocol):
    async def push_audio(self, audio_bytes: bytes) -> Iterable[TranscriptChunk]:
        ...

    async def flush(self) -> Iterable[TranscriptChunk]:
        ...


class StreamingTtsAdapter(Protocol):
    async def synthesize(self, text: str) -> Iterable[AudioChunk]:
        ...
