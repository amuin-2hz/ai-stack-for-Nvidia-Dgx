"""Configuration helpers for the realtime audio service."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(slots=True)
class Settings:
    host: str = os.getenv("AUDIO_SERVICE_HOST", "0.0.0.0")
    port: int = int(os.getenv("AUDIO_SERVICE_PORT", "9000"))
    device: str = os.getenv("AUDIO_DEVICE", "cuda:0")
    asr_model: str = os.getenv("FUNASR_MODEL", "FunAudioLLM/Fun-ASR-MLT-Nano-2512")
    asr_vad_model: str = os.getenv("FUNASR_VAD_MODEL", "fsmn-vad")
    asr_punc_model: str = os.getenv("FUNASR_PUNC_MODEL", "ct-punc")
    tts_model: str = os.getenv("COSYVOICE_MODEL", "iic/CosyVoice-300M-SFT")
    models_root: str = os.getenv("MODELS_ROOT", "/models")
    asr_sample_rate: int = int(os.getenv("AUDIO_INPUT_SAMPLE_RATE", "16000"))
    tts_sample_rate: int = int(os.getenv("AUDIO_OUTPUT_SAMPLE_RATE", "24000"))
    enable_mock_fallback: bool = os.getenv("AUDIO_ENABLE_MOCK_FALLBACK", "0") == "1"


settings = Settings()
