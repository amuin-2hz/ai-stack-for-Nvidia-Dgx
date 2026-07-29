"""Dedicated OpenAI-compatible gateway for the local Qwen3-TTS model family."""
from __future__ import annotations

import argparse
import base64
import binascii
import gc
import importlib.util
import io
import os
import re
import subprocess
import tempfile
import threading
import uuid
from collections import OrderedDict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterator, Literal

import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field


@dataclass(frozen=True)
class ModelSpec:
    id: str
    kind: Literal["custom_voice", "voice_design", "voice_clone"]
    path: str


MODEL_SPECS = (
    ModelSpec(
        id="qwen3-tts-12hz-1.7b-customvoice",
        kind="custom_voice",
        path=os.environ.get(
            "QWEN3_TTS_CUSTOMVOICE_PATH",
            "/models/qwen3-tts-12hz-1.7b-customvoice",
        ),
    ),
    ModelSpec(
        id="qwen3-tts-12hz-1.7b-voicedesign",
        kind="voice_design",
        path=os.environ.get(
            "QWEN3_TTS_VOICEDESIGN_PATH",
            "/models/qwen3-tts-12hz-1.7b-voicedesign",
        ),
    ),
    ModelSpec(
        id="qwen3-tts-12hz-1.7b-base",
        kind="voice_clone",
        path=os.environ.get(
            "QWEN3_TTS_BASE_PATH",
            "/models/qwen3-tts-12hz-1.7b-base",
        ),
    ),
)

DEFAULT_MODEL = MODEL_SPECS[0].id
SUPPORTED_SPEAKERS = {
    "vivian": "Vivian",
    "serena": "Serena",
    "uncle_fu": "Uncle_Fu",
    "dylan": "Dylan",
    "eric": "Eric",
    "ryan": "Ryan",
    "aiden": "Aiden",
    "ono_anna": "Ono_Anna",
    "sohee": "Sohee",
}
SUPPORTED_LANGUAGES = {
    "auto": "Auto",
    "chinese": "Chinese",
    "english": "English",
    "japanese": "Japanese",
    "korean": "Korean",
    "german": "German",
    "french": "French",
    "russian": "Russian",
    "portuguese": "Portuguese",
    "spanish": "Spanish",
    "italian": "Italian",
}
FORMAT_MEDIA_TYPES = {
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "flac": "audio/flac",
    "opus": "audio/ogg",
    "aac": "audio/aac",
    "pcm": "audio/pcm",
}
STREAMABLE_FORMATS = {"pcm", "mp3", "opus", "aac"}


class SpeechRequest(BaseModel):
    """OpenAI speech request plus explicit Qwen3-TTS extensions."""

    model_config = ConfigDict(extra="forbid")

    model: str = DEFAULT_MODEL
    input: str = Field(min_length=1)
    voice: str | None = None
    response_format: Literal["mp3", "wav", "flac", "opus", "aac", "pcm"] = "mp3"
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    language: str = "Auto"
    instructions: str | None = None
    instruct: str | None = None
    reference_audio: str | None = None
    reference_text: str | None = None
    x_vector_only_mode: bool = False
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)
    max_new_tokens: int | None = Field(default=None, ge=1, le=8192)
    top_p: float | None = Field(default=None, gt=0, le=1)
    temperature: float | None = Field(default=None, gt=0, le=2)
    stream: bool = False
    stream_chunk_chars: int = Field(default=120, ge=20, le=1000)


app = FastAPI(title="AMUIN Qwen3-TTS Gateway", version="1.1.0")
_model_cache: OrderedDict[str, Any] = OrderedDict()
_cache_lock = threading.RLock()
_inference_slots = threading.BoundedSemaphore(
    max(1, int(os.environ.get("QWEN3_TTS_MAX_CONCURRENCY", "1")))
)


def _primary_model_id() -> str:
    return os.environ.get("QWEN3_TTS_PRIMARY_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL


def _aliases() -> dict[str, ModelSpec]:
    aliases: dict[str, ModelSpec] = {}
    for spec in MODEL_SPECS:
        aliases[spec.id.lower()] = spec
        aliases[("Qwen/Qwen3-TTS-12Hz-1.7B-" + {
            "custom_voice": "CustomVoice",
            "voice_design": "VoiceDesign",
            "voice_clone": "Base",
        }[spec.kind]).lower()] = spec
    primary = aliases.get(_primary_model_id().lower())
    served_alias = os.environ.get("OPENAI_MODEL", "").strip()
    if primary and served_alias:
        aliases[served_alias.lower()] = primary
    return aliases


def _resolve_model(model_id: str) -> ModelSpec:
    spec = _aliases().get(model_id.strip().lower())
    if spec is None:
        raise HTTPException(status_code=400, detail=f"Unsupported Qwen3-TTS model: {model_id}")
    return spec


def _model_readiness(spec: ModelSpec) -> tuple[bool, str]:
    path = Path(spec.path)
    if not path.is_dir():
        return False, "model directory is missing"
    if (path / ".temp").exists():
        return False, "download staging directory is still present"
    required = (path / "config.json", path / "model.safetensors")
    missing = [item.name for item in required if not item.is_file()]
    if missing:
        return False, "missing required file(s): " + ", ".join(missing)
    require_marker = os.environ.get("QWEN3_TTS_REQUIRE_COMPLETE_MARKER", "true").lower() == "true"
    if require_marker and not (path / ".download-complete").is_file():
        return False, "download completion marker is missing"
    return True, "ready"


def _model_status(spec: ModelSpec) -> dict[str, Any]:
    ready, detail = _model_readiness(spec)
    return {
        **asdict(spec),
        "ready": ready,
        "detail": detail,
        "loaded": spec.id in _model_cache,
    }


@app.get("/healthz")
def healthz() -> JSONResponse:
    try:
        primary = _resolve_model(_primary_model_id())
        primary_ready, primary_detail = _model_readiness(primary)
    except HTTPException as error:
        primary = None
        primary_ready = False
        primary_detail = str(error.detail)
    body = {
        "status": "ok" if primary_ready else "not_ready",
        "service": "qwen3-tts",
        "primary_model": primary.id if primary else _primary_model_id(),
        "primary_model_detail": primary_detail,
        "loaded_models": list(_model_cache.keys()),
        "models": [_model_status(spec) for spec in MODEL_SPECS],
    }
    return JSONResponse(body, status_code=200 if primary_ready else 503)


@app.get("/v1/models")
def models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {
                "id": spec.id,
                "object": "model",
                "owned_by": "Qwen",
                "capability": spec.kind,
                "path": spec.path,
                "ready": _model_readiness(spec)[0],
            }
            for spec in MODEL_SPECS
        ],
    }


@app.get("/v1/audio/voices")
def voices() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {"id": speaker, "object": "voice", "model": MODEL_SPECS[0].id}
            for speaker in SUPPORTED_SPEAKERS.values()
        ],
    }


def _torch_dtype(torch: Any) -> Any:
    configured = os.environ.get("QWEN3_TTS_DTYPE", "bfloat16").lower()
    if configured in {"bf16", "bfloat16"}:
        return torch.bfloat16
    if configured in {"fp16", "float16"}:
        return torch.float16
    if configured in {"fp32", "float32"}:
        return torch.float32
    raise RuntimeError(f"Unsupported QWEN3_TTS_DTYPE: {configured}")


def _attention_implementation() -> str:
    configured = os.environ.get("QWEN3_TTS_ATTN_IMPLEMENTATION", "auto").lower()
    if configured != "auto":
        return configured
    return "flash_attention_2" if importlib.util.find_spec("flash_attn") else "sdpa"


def _release_model(model: Any) -> None:
    del model
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _get_model(spec: ModelSpec) -> Any:
    with _cache_lock:
        cached = _model_cache.pop(spec.id, None)
        if cached is not None:
            _model_cache[spec.id] = cached
            return cached
        ready, detail = _model_readiness(spec)
        if not ready:
            raise HTTPException(status_code=503, detail=f"{spec.id} is not ready: {detail}")

        import torch
        from qwen_tts import Qwen3TTSModel

        model = Qwen3TTSModel.from_pretrained(
            spec.path,
            device_map=os.environ.get("QWEN3_TTS_DEVICE", "cuda:0"),
            dtype=_torch_dtype(torch),
            attn_implementation=_attention_implementation(),
            local_files_only=True,
        )
        cache_size = max(1, int(os.environ.get("QWEN3_TTS_MODEL_CACHE_SIZE", "1")))
        while len(_model_cache) >= cache_size:
            _, evicted = _model_cache.popitem(last=False)
            _release_model(evicted)
        _model_cache[spec.id] = model
        return model


def _normalize_language(value: str) -> str:
    language = SUPPORTED_LANGUAGES.get(value.strip().lower())
    if language is None:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {value}")
    return language


def _normalize_speaker(value: str | None) -> str:
    key = (value or "Vivian").strip().lower()
    speaker = SUPPORTED_SPEAKERS.get(key)
    if speaker is None:
        raise HTTPException(status_code=400, detail=f"Unsupported CustomVoice speaker: {value}")
    return speaker


def _reference_audio_file(value: str) -> str:
    if not value.startswith("data:audio/") or ";base64," not in value[:128]:
        raise HTTPException(
            status_code=400,
            detail="reference_audio must be a base64 audio data URL; remote URLs and server paths are disabled",
        )
    header, encoded = value.split(",", 1)
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise HTTPException(status_code=400, detail="reference_audio is not valid base64") from error
    max_bytes = int(os.environ.get("QWEN3_TTS_MAX_REFERENCE_AUDIO_BYTES", str(15 * 1024 * 1024)))
    if not payload or len(payload) > max_bytes:
        raise HTTPException(status_code=413, detail=f"reference_audio must be between 1 and {max_bytes} bytes")
    media_type = header.split(";", 1)[0].lower()
    suffix = {
        "data:audio/wav": ".wav",
        "data:audio/x-wav": ".wav",
        "data:audio/mpeg": ".mp3",
        "data:audio/mp3": ".mp3",
        "data:audio/flac": ".flac",
        "data:audio/ogg": ".ogg",
        "data:audio/mp4": ".m4a",
    }.get(media_type, ".audio")
    handle = tempfile.NamedTemporaryFile(prefix="qwen3-tts-ref-", suffix=suffix, delete=False)
    try:
        handle.write(payload)
        return handle.name
    finally:
        handle.close()


def _generation_kwargs(payload: SpeechRequest) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key in ("max_new_tokens", "top_p", "temperature"):
        value = getattr(payload, key)
        if value is not None:
            result[key] = value
    return result


def _generate(payload: SpeechRequest, spec: ModelSpec) -> tuple[Any, int]:
    max_chars = int(os.environ.get("QWEN3_TTS_MAX_INPUT_CHARS", "4000"))
    if len(payload.input) > max_chars:
        raise HTTPException(status_code=413, detail=f"input exceeds the {max_chars}-character limit")
    language = _normalize_language(payload.language)
    instructions = payload.instructions if payload.instructions is not None else payload.instruct
    reference_path: str | None = None
    with _inference_slots:
        model = _get_model(spec)
        if payload.seed is not None:
            import torch

            torch.manual_seed(payload.seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(payload.seed)
        kwargs = _generation_kwargs(payload)
        try:
            if spec.kind == "custom_voice":
                wavs, sample_rate = model.generate_custom_voice(
                    text=payload.input,
                    language=language,
                    speaker=_normalize_speaker(payload.voice),
                    instruct=instructions or "",
                    **kwargs,
                )
            elif spec.kind == "voice_design":
                if not instructions or not instructions.strip():
                    raise HTTPException(status_code=400, detail="instructions is required for VoiceDesign")
                wavs, sample_rate = model.generate_voice_design(
                    text=payload.input,
                    language=language,
                    instruct=instructions.strip(),
                    **kwargs,
                )
            else:
                if not payload.reference_audio:
                    raise HTTPException(status_code=400, detail="reference_audio is required for the Base voice-clone model")
                if not payload.x_vector_only_mode and not (payload.reference_text or "").strip():
                    raise HTTPException(
                        status_code=400,
                        detail="reference_text is required unless x_vector_only_mode is true",
                    )
                reference_path = _reference_audio_file(payload.reference_audio)
                wavs, sample_rate = model.generate_voice_clone(
                    text=payload.input,
                    language=language,
                    ref_audio=reference_path,
                    ref_text=(payload.reference_text or "").strip() or None,
                    x_vector_only_mode=payload.x_vector_only_mode,
                    **kwargs,
                )
        finally:
            if reference_path:
                Path(reference_path).unlink(missing_ok=True)
    if not wavs:
        raise RuntimeError("Qwen3-TTS returned no audio")
    return wavs[0], int(sample_rate)


def _wav_bytes(waveform: Any, sample_rate: int) -> bytes:
    target = io.BytesIO()
    sf.write(target, waveform, sample_rate, format="WAV", subtype="PCM_16")
    return target.getvalue()


def _atempo_filter(speed: float) -> str | None:
    if abs(speed - 1.0) < 1e-6:
        return None
    factors: list[float] = []
    remaining = speed
    while remaining > 2.0:
        factors.append(2.0)
        remaining /= 2.0
    while remaining < 0.5:
        factors.append(0.5)
        remaining /= 0.5
    factors.append(remaining)
    return ",".join(f"atempo={factor:.6f}" for factor in factors)


def _encode_audio(wav: bytes, response_format: str, speed: float, sample_rate: int) -> bytes:
    tempo = _atempo_filter(speed)
    if response_format == "wav" and tempo is None:
        return wav
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0"]
    if tempo:
        command.extend(["-filter:a", tempo])
    if response_format == "mp3":
        command.extend(["-c:a", "libmp3lame", "-f", "mp3"])
    elif response_format == "opus":
        command.extend(["-c:a", "libopus", "-f", "ogg"])
    elif response_format == "aac":
        command.extend(["-c:a", "aac", "-f", "adts"])
    elif response_format == "pcm":
        command.extend(["-c:a", "pcm_s16le", "-ar", str(sample_rate), "-f", "s16le"])
    else:
        command.extend(["-f", response_format])
    command.append("pipe:1")
    completed = subprocess.run(command, input=wav, capture_output=True, check=False)
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace")[-500:]
        raise RuntimeError(f"audio encoding failed: {detail}")
    return completed.stdout


def _split_stream_text(text: str, max_chars: int) -> list[str]:
    """Split text at natural boundaries while enforcing a hard chunk limit."""

    normalized = text.strip()
    if not normalized:
        return []
    pieces = [
        piece
        for piece in re.split(r"(?<=[。！？!?；;\n])", normalized)
        if piece.strip()
    ]
    chunks: list[str] = []
    current = ""
    for piece in pieces:
        hard_parts = [
            piece[index : index + max_chars]
            for index in range(0, len(piece), max_chars)
        ]
        for part in hard_parts:
            if current and len(current) + len(part) > max_chars:
                chunks.append(current)
                current = ""
            current += part
            if len(current) >= max_chars:
                chunks.append(current)
                current = ""
    if current:
        chunks.append(current)
    return chunks


def _strip_id3v2(audio: bytes) -> bytes:
    """Remove an ID3v2 header so independently encoded MP3 chunks concatenate."""

    if len(audio) < 10 or audio[:3] != b"ID3":
        return audio
    size_bytes = audio[6:10]
    if any(value & 0x80 for value in size_bytes):
        raise RuntimeError("invalid ID3v2 syncsafe size in streaming MP3 chunk")
    payload_size = (
        (size_bytes[0] << 21)
        | (size_bytes[1] << 14)
        | (size_bytes[2] << 7)
        | size_bytes[3]
    )
    header_size = 10 + payload_size + (10 if audio[5] & 0x10 else 0)
    if header_size >= len(audio):
        raise RuntimeError("streaming MP3 chunk contains no audio frames")
    return audio[header_size:]


def _stream_audio_chunk(
    payload: SpeechRequest,
    spec: ModelSpec,
    text: str,
) -> tuple[bytes, int]:
    chunk_payload = payload.model_copy(update={"input": text, "stream": False})
    waveform, sample_rate = _generate(chunk_payload, spec)
    audio = _encode_audio(
        _wav_bytes(waveform, sample_rate),
        payload.response_format,
        payload.speed,
        sample_rate,
    )
    return audio, sample_rate


def _stream_speech_response(
    payload: SpeechRequest,
    spec: ModelSpec,
    request_id: str,
) -> StreamingResponse:
    if payload.response_format not in STREAMABLE_FORMATS:
        supported = ", ".join(sorted(STREAMABLE_FORMATS))
        raise HTTPException(
            status_code=400,
            detail=(
                f"stream=true requires one of these response formats: {supported}; "
                "WAV and FLAC need final file sizes and remain non-streaming"
            ),
        )
    text_chunks = _split_stream_text(payload.input, payload.stream_chunk_chars)
    if not text_chunks:
        raise HTTPException(status_code=400, detail="input must contain non-whitespace text")

    # Generate the first segment before sending response headers so model/input
    # errors still produce a normal JSON error instead of a truncated audio stream.
    first_audio, sample_rate = _stream_audio_chunk(payload, spec, text_chunks[0])

    def audio_iterator() -> Iterator[bytes]:
        yield first_audio
        for text_chunk in text_chunks[1:]:
            audio, chunk_sample_rate = _stream_audio_chunk(payload, spec, text_chunk)
            if payload.response_format == "mp3":
                audio = _strip_id3v2(audio)
            if chunk_sample_rate != sample_rate:
                raise RuntimeError(
                    "Qwen3-TTS changed sample rate during a streaming response"
                )
            yield audio

    return StreamingResponse(
        audio_iterator(),
        media_type=FORMAT_MEDIA_TYPES[payload.response_format],
        headers={
            "Content-Disposition": (
                f'inline; filename="{request_id}.{payload.response_format}"'
            ),
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "X-AI-Stack-Model": spec.id,
            "X-AI-Stack-Sample-Rate": str(sample_rate),
            "X-AI-Stack-Stream-Mode": "segmented",
            "X-AI-Stack-Stream-Chunks": str(len(text_chunks)),
            "X-Request-Id": request_id,
        },
    )


@app.post("/v1/audio/speech")
def speech(payload: SpeechRequest) -> Response:
    spec = _resolve_model(payload.model)
    request_id = "speech-" + uuid.uuid4().hex
    try:
        if payload.stream:
            return _stream_speech_response(payload, spec, request_id)
        waveform, sample_rate = _generate(payload, spec)
        audio = _encode_audio(
            _wav_bytes(waveform, sample_rate),
            payload.response_format,
            payload.speed,
            sample_rate,
        )
        return Response(
            content=audio,
            media_type=FORMAT_MEDIA_TYPES[payload.response_format],
            headers={
                "Content-Disposition": f'inline; filename="{request_id}.{payload.response_format}"',
                "X-AI-Stack-Model": spec.id,
                "X-AI-Stack-Sample-Rate": str(sample_rate),
                "X-Request-Id": request_id,
            },
        )
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Qwen3-TTS inference failed: {error}") from error


@app.on_event("startup")
def eager_load_primary_model() -> None:
    if os.environ.get("QWEN3_TTS_EAGER_LOAD", "true").lower() != "true":
        return
    spec = _resolve_model(_primary_model_id())
    _get_model(spec)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, workers=1)


if __name__ == "__main__":
    main()
