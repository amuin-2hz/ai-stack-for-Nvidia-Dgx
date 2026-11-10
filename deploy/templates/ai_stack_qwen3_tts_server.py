"""Dedicated OpenAI-compatible gateway for the local Qwen3-TTS model family."""
from __future__ import annotations

import argparse
import base64
import binascii
import gc
import importlib.util
import io
import json
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
from urllib.parse import quote

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
    debug: bool = False


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
    # 只有当别名不与真实模型 id 冲突时才注册，否则会把 customvoice 请求劫持到 base
    if primary and served_alias and served_alias.lower() not in aliases:
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


@app.get("/v1/lexicon")
def lexicon() -> dict[str, Any]:
    return {
        "path": str(LEXICON_PATH),
        "count": len(_load_lexicon()),
        "entries": [
            {"term": term, "say": say, "note": note}
            for term, say, note in _load_lexicon()
        ],
    }


@app.get("/v1/audio/voices")
def voices() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {"id": speaker, "object": "voice", "model": MODEL_SPECS[0].id}
            for speaker in SUPPORTED_SPEAKERS.values()
        ] + _list_saved_voices(),
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


VOICE_DIR = Path(os.environ.get("QWEN3_TTS_VOICE_DIR", "/cache/voices"))


def _voice_path(voice_id: str) -> Path:
    safe = re.sub(r"[^0-9A-Za-z_.\-\u4e00-\u9fff]", "_", (voice_id or "").strip()).strip("._")
    return VOICE_DIR / f"{safe or 'voice'}.qvoice"


def _list_saved_voices() -> list[dict[str, Any]]:
    if not VOICE_DIR.is_dir():
        return []
    return [
        {"id": path.stem, "object": "voice", "kind": "cloned",
         "model": "qwen3-tts-12hz-1.7b-base"}
        for path in sorted(VOICE_DIR.glob("*.qvoice"))
    ]


def _load_clone_prompt(name: str):
    """读取 .qvoice（ref_code + 说话人向量），转成 generate_voice_clone 需要的 prompt"""
    import torch
    from qwen_tts.inference.qwen3_tts_model import VoiceClonePromptItem

    path = _voice_path(name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"unknown voice: {name}")
    obj = torch.load(path, map_location="cpu", weights_only=True)
    if isinstance(obj, list):
        return obj
    return [
        VoiceClonePromptItem(
            ref_code=obj.get("ref_code"),
            ref_spk_embedding=obj["ref_spk_embedding"],
            x_vector_only_mode=bool(obj.get("x_vector_only_mode", False)),
            icl_mode=bool(obj.get("icl_mode", True)),
            ref_text=obj.get("ref_text"),
        )
    ]


def _generation_kwargs(payload: SpeechRequest) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key in ("max_new_tokens", "top_p", "temperature"):
        value = getattr(payload, key)
        if value is not None:
            result[key] = value
    return result


def _generate(payload: SpeechRequest, spec: ModelSpec) -> tuple[Any, int]:
    payload = payload.model_copy(update={"input": _normalize_tts_text(payload.input)})
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
                saved_voice = (payload.voice or "").strip()
                if saved_voice and not payload.reference_audio and _voice_path(saved_voice).is_file():
                    wavs, sample_rate = model.generate_voice_clone(
                        text=payload.input,
                        language=language,
                        voice_clone_prompt=_load_clone_prompt(saved_voice),
                        **kwargs,
                    )
                    return _shape_waveform(wavs[0], int(sample_rate)), int(sample_rate)
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
    return _shape_waveform(wavs[0], int(sample_rate)), int(sample_rate)


DEBUG_DIR = Path(os.environ.get("QWEN3_TTS_DEBUG_DIR", "/cache/debug"))
_DEBUG_ALWAYS = os.environ.get("QWEN3_TTS_DEBUG_DUMP", "0").lower() in ("1", "true", "yes")
_DEBUG_KEEP = int(os.environ.get("QWEN3_TTS_DEBUG_KEEP", "50"))


def _debug_dump(request_id: str, response_format: str, data: bytes) -> None:
    print(f"[debug] dump {request_id} -> {DEBUG_DIR} ({len(data)} bytes)", flush=True)
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    (DEBUG_DIR / f"{request_id}.{response_format}").write_bytes(data)
    try:
        files = sorted(DEBUG_DIR.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in files[_DEBUG_KEEP:]:
            old.unlink(missing_ok=True)
    except Exception:
        pass


TRIM_MARGIN_SEC = float(os.environ.get("QWEN3_TTS_TRIM_MARGIN", "0.05"))
TRIM_THRESHOLD = float(os.environ.get("QWEN3_TTS_TRIM_THRESHOLD", "0.012"))
TRIM_FADE_SEC = float(os.environ.get("QWEN3_TTS_TRIM_FADE", "0.03"))


def _shape_waveform(waveform: Any, sample_rate: int) -> Any:
    """裁掉首尾静音并加淡入淡出，避免多段拼接时出现“噗/咔”声。"""
    import numpy as np

    x = np.asarray(waveform, dtype=np.float32).reshape(-1)
    if x.size < int(0.05 * sample_rate):
        return x

    env = np.abs(x)
    above = np.where(env > TRIM_THRESHOLD)[0]
    if above.size:
        margin = int(TRIM_MARGIN_SEC * sample_rate)
        start = max(0, int(above[0]) - margin)
        end = min(x.size, int(above[-1]) + margin)
        if end - start > int(0.05 * sample_rate):
            x = x[start:end].copy()

    n = min(int(TRIM_FADE_SEC * sample_rate), max(1, x.size // 2))
    if n > 1:
        ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
        x[:n] *= ramp
        x[-n:] *= ramp[::-1]
    return x


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


_MARKDOWN_RULES = [
    (re.compile(r"!\[[^\]]*\]\([^)]*\)"), ""),
    (re.compile(r"\[([^\]]*)\]\([^)]*\)"), r"\1"),
    (re.compile(r"(`{1,3})(.+?)\1", re.S), r"\2"),
    (re.compile(r"(\*\*|__)(.+?)\1", re.S), r"\2"),
    (re.compile(r"(?<![\w*])(\*|_)(?!\s)(.+?)(?<!\s)\1(?![\w*])", re.S), r"\2"),
    (re.compile(r"~~(.+?)~~", re.S), r"\1"),
    (re.compile(r"^\s{0,3}#{1,6}\s*", re.M), ""),
    (re.compile(r"^\s{0,3}[-*+•]\s+", re.M), ""),
    (re.compile(r"^\s{0,3}>\s?", re.M), ""),
    (re.compile(r"^\s{0,3}\|?(?:\s*:?-{3,}:?\s*\|)+\s*$", re.M), ""),
]


LEXICON_PATH = Path(os.environ.get("QWEN3_TTS_LEXICON", "/cache/lexicon.json"))
_LEXICON_CACHE: dict[str, Any] = {"mtime": None, "entries": []}


def _load_lexicon() -> list[tuple[str, str, str]]:
    """读取发音词典，按文件 mtime 热更新；长词优先。"""
    try:
        stat = LEXICON_PATH.stat()
    except OSError:
        return []
    if _LEXICON_CACHE["mtime"] != stat.st_mtime:
        entries: list[tuple[str, str, str]] = []
        try:
            data = json.loads(LEXICON_PATH.read_text(encoding="utf-8"))
            for item in data.get("entries", []):
                term = str(item.get("term", "")).strip()
                say = str(item.get("say", "")).strip()
                if term and say:
                    entries.append((term, say, str(item.get("note", ""))))
        except Exception:
            entries = []
        entries.sort(key=lambda item: len(item[0]), reverse=True)
        _LEXICON_CACHE["entries"] = entries
        _LEXICON_CACHE["mtime"] = stat.st_mtime
    return _LEXICON_CACHE["entries"]


def _apply_lexicon(text: str) -> str:
    """把词表里的写法替换成“读得对”的写法。英文按单词边界、忽略大小写。"""
    for term, say, _note in _load_lexicon():
        if term.isascii() and term.replace(" ", "").isalnum():
            text = re.sub(
                rf"(?<![A-Za-z0-9]){re.escape(term)}(?![A-Za-z0-9])",
                say,
                text,
                flags=re.IGNORECASE,
            )
        else:
            text = text.replace(term, say)
    return text


def _lexicon_hits(text: str) -> list[str]:
    hits = []
    lowered = text.lower()
    for term, say, _note in _load_lexicon():
        if term in text or (term.isascii() and term.lower() in lowered):
            hits.append(f"{term}=>{say}")
    return hits[:10]


CJK_RANGE = "\\u4e00-\\u9fff"


def _tidy_spacing(value: str) -> str:
    """模板类文本里常见“年 年 月 月 日 日 ， ”这种空格，会被念成一顿一顿。"""
    value = re.sub(r"[ \t\u3000]+", " ", value)
    # 汉字之间、汉字与中文标点之间的空格
    value = re.sub(rf"(?<=[{CJK_RANGE}]) (?=[{CJK_RANGE}])", "", value)
    value = re.sub(rf"(?<=[{CJK_RANGE}]) (?=[，。！？；：、）”’」』》])", "", value)
    value = re.sub(rf"(?<=[（“‘「『《]) (?=[{CJK_RANGE}])", "", value)
    # 关闭符号与汉字之间、汉字与开启符号之间的空格（“（一） 任务一”这类）
    value = re.sub(rf"(?<=[）”’」』》]) (?=[{CJK_RANGE}])", "", value)
    value = re.sub(rf"(?<=[{CJK_RANGE}]) (?=[（“‘「『《])", "", value)
    # 被空格夹住的中文标点
    value = re.sub(r" ?([，。！？；：、]) ?", r"\1", value)
    # 连续重复的标点
    value = re.sub(r"([，。！？；：、])\1+", r"\1", value)
    return value.strip()


def _normalize_tts_text(text: str) -> str:
    """朗读前清洗：保留正文，去掉 Markdown/零宽字符，压平空白。"""
    value = (text or "").replace("\r\n", "\n")
    value = value.replace("\u200b", "").replace("\ufeff", "")
    for pattern, repl in _MARKDOWN_RULES:
        value = pattern.sub(repl, value)
    value = value.replace("\n", " ")
    value = re.sub(r"[ \t\u00a0]+", " ", value).strip()
    # 去掉首尾标点：业务侧会发“，XXX。”这类片段，开头的逗号会被念成一声“噗”
    value = re.sub(r"^[，。！？；：、,.!?;:…—－\-\s]+", "", value)
    value = re.sub(r"[，、；：,;:\s]+$", "", value)
    value = _tidy_spacing(value)
    value = _apply_lexicon(value)
    return value


_OPEN_CHARS = "“‘「『（(【《"
_CLOSE_CHARS = "”’」』）)】》"
_SOFT_CHARS = "，、；：,;:"


def _is_ascii_word(ch: str) -> bool:
    return ch.isascii() and ch.isalnum()


def _join_parts(a: str, b: str) -> str:
    if not a:
        return b
    if not b:
        return a
    if _is_ascii_word(a[-1]) and _is_ascii_word(b[0]):
        return a + " " + b
    return a + b


def _split_long_piece(piece: str, max_chars: int) -> list[str]:
    """长句在软标点处断开；引号/括号未闭合时宁可变长也不切。"""
    if len(piece) <= max_chars:
        return [piece]
    out: list[str] = []
    buf = ""
    depth = 0
    for ch in piece:
        buf += ch
        if ch in _OPEN_CHARS:
            depth += 1
        elif ch in _CLOSE_CHARS:
            depth = max(0, depth - 1)
        if depth == 0 and ch in _SOFT_CHARS and len(buf) >= max_chars * 0.55:
            out.append(buf)
            buf = ""
        elif depth == 0 and len(buf) >= max_chars:
            out.append(buf)
            buf = ""
        elif len(buf) >= max_chars * 1.6:
            out.append(buf)
            buf = ""
    if buf:
        out.append(buf)
    return out


def _split_stream_text(text: str, max_chars: int) -> list[str]:
    """按句末标点切块：引号/括号不跨块，长句在软标点处断开，过短块并回上一块。"""
    normalized = (text or "").replace("\r\n", "\n").strip()
    if not normalized:
        return []
    max_chars = max(20, int(max_chars))

    sentences = [
        sentence.strip()
        for sentence in re.split(
            r"(?<=[。！？!?…])(?![”’」』）)】》\"'])|(?<=\n)", normalized
        )
        if sentence and sentence.strip()
    ]

    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        for part in _split_long_piece(sentence, max_chars):
            if current and len(current) + len(part) > max_chars:
                chunks.append(current)
                current = ""
            current = _join_parts(current, part)
    if current:
        chunks.append(current)

    merged: list[str] = []
    for chunk in chunks:
        if merged and (len(chunk) < 12 or chunk[0] in "，、；：,;:”’」』）)】》"):
            merged[-1] = _join_parts(merged[-1], chunk)
        else:
            merged.append(chunk)
    return [chunk for chunk in merged if chunk.strip()]


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


def _as_float_array(waveform: Any):
    """把模型输出统一成 float32 numpy（兼容 torch tensor / list）。"""
    import numpy as np

    if hasattr(waveform, "detach"):
        waveform = waveform.detach().float().cpu().numpy()
    return np.asarray(waveform, dtype=np.float32).reshape(-1)


def _pcm16_stream_block(waveform: Any, sample_rate: int) -> bytes:
    """float32 波形 -> 16bit 单声道 PCM；首尾各 12ms 淡入淡出，避免拼接阶跃。"""
    import numpy as np

    wf = _as_float_array(waveform).copy()
    n = min(int(0.012 * sample_rate), max(1, len(wf) // 2))
    if n > 1:
        ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
        wf[:n] *= ramp
        wf[-n:] *= ramp[::-1]
    return (np.clip(wf, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


_MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
_MP3_RATES_V2 = {24000: 2, 22050: 1, 16000: 0}
_MP3_RATES_V1 = {48000: 1, 44100: 0, 32000: 2}


class _Mp3Framer:
    """把字节流切成完整 MP3 帧；不足一帧就攒着，保证每次 yield 都从帧头开始。"""

    def __init__(self, min_frames: int = 8) -> None:
        self.buf = bytearray()
        self.min_bytes = 0
        self.min_frames = min_frames
        self.frame_bytes = 0
        self.skip = 0

    def _frame_len(self, hdr: bytes) -> int:
        if len(hdr) < 4 or hdr[0] != 0xFF or (hdr[1] & 0xE0) != 0xE0:
            return 0
        version = (hdr[1] >> 3) & 0x03      # 3=MPEG1, 2=MPEG2, 0=MPEG2.5
        layer = (hdr[1] >> 1) & 0x03        # 1=Layer III
        if layer != 0x01:
            return 0
        bitrate_idx = (hdr[2] >> 4) & 0x0F
        rate_idx = (hdr[2] >> 2) & 0x03
        padding = (hdr[2] >> 1) & 0x01
        if bitrate_idx == 0 or bitrate_idx == 15 or rate_idx == 3:
            return 0
        if version == 3:
            rates = {48000: 1, 44100: 0, 32000: 2}
            rate = [44100, 48000, 32000][rate_idx]
            kbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][bitrate_idx]
            return int(144000 * kbps / rate) + padding
        rates = {24000: 2, 22050: 1, 16000: 0}
        rate = [22050, 24000, 16000][rate_idx]
        kbps = _MP3_BITRATES_V2_L3[bitrate_idx]
        return int(72000 * kbps / rate) + padding

    def feed(self, data: bytes) -> list[bytes]:
        self.buf.extend(data)
        out: list[bytes] = []
        # 跳过 ID3v2（如果有）
        if self.skip == 0 and self.buf[:3] == b"ID3" and len(self.buf) >= 10:
            size = ((self.buf[6] & 0x7F) << 21) | ((self.buf[7] & 0x7F) << 14) | \
                   ((self.buf[8] & 0x7F) << 7) | (self.buf[9] & 0x7F)
            self.skip = 10 + size
        while True:
            if self.skip:
                if len(self.buf) < self.skip:
                    return out
                del self.buf[: self.skip]
                self.skip = 0
            if len(self.buf) < 4:
                return out
            if not self.frame_bytes:
                flen = self._frame_len(bytes(self.buf[:4]))
                if not flen:
                    del self.buf[0]          # 找不到同步字，丢一个字节继续找
                    continue
                self.frame_bytes = flen
            need = self.frame_bytes * self.min_frames
            if len(self.buf) < need:
                return out
            out.append(bytes(self.buf[:need]))
            del self.buf[:need]
        return out

    def flush(self) -> bytes:
        rest = bytes(self.buf)
        self.buf.clear()
        return rest


def _write_all(stream: Any, data: bytes) -> None:
    """把 data 完整写入管道；pipe 的 write 可能短写，必须循环。"""
    view = memoryview(data)
    while view:
        written = stream.write(view)
        if written is None:
            return
        if written <= 0:
            raise IOError("encoder stdin closed")
        view = view[written:]


def _stream_encoder_command(
    response_format: str, speed: float, sample_rate: int
) -> list[str]:
    """单路编码器：所有分块的 PCM 依次喂进同一个 ffmpeg，只编码一次，接缝为零。"""
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "s16le", "-ar", str(sample_rate), "-ac", "1", "-i", "pipe:0",
        "-flush_packets", "1",
    ]
    tempo = _atempo_filter(speed)
    if tempo:
        command.extend(["-filter:a", tempo])
    if response_format == "mp3":
        # 管道输出时 Xing/Info 头里是占位时长，部分流式播放器会误判首帧而爆音
        command.extend(["-c:a", "libmp3lame", "-b:a", "96k", "-write_xing", "0", "-f", "mp3"])
    elif response_format == "opus":
        command.extend(["-c:a", "libopus", "-b:a", "48k", "-f", "ogg"])
    elif response_format == "aac":
        command.extend(["-c:a", "aac", "-b:a", "96k", "-f", "adts"])
    else:
        command.extend(["-f", response_format])
    command.append("pipe:1")
    return command


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
    text_chunks = _split_stream_text(_normalize_tts_text(payload.input), payload.stream_chunk_chars)
    if not text_chunks:
        raise HTTPException(status_code=400, detail="input must contain non-whitespace text")

    # 第一块先算完：模型/输入错误仍能在响应头之前以 JSON 报错
    first_wave, sample_rate = _generate(
        payload.model_copy(update={"input": text_chunks[0], "stream": False}), spec
    )
    lead_silence = b"\x00\x00" * int(0.04 * sample_rate)   # 40ms 起始静音，吸收解码器预热
    first_pcm = lead_silence + _pcm16_stream_block(first_wave, sample_rate)

    headers = {
        "Content-Disposition": (
            f'inline; filename="{request_id}.{payload.response_format}"'
        ),
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        "X-AI-Stack-Model": spec.id,
        "X-AI-Stack-Sample-Rate": str(sample_rate),
        "X-AI-Stack-Stream-Mode": "continuous-encoder",
        "X-AI-Stack-Stream-Chunks": str(len(text_chunks)),
        "X-Request-Id": request_id,
    }
    lexicon_hits = _lexicon_hits(payload.input)
    if lexicon_hits:
        headers["X-AI-Stack-Lexicon"] = quote("; ".join(lexicon_hits))
    media_type = FORMAT_MEDIA_TYPES[payload.response_format]

    # 分块之间补 90ms 静音，让每块像“一句话”自然收尾，避免块首爆破音被听成“吹话筒”
    gap_bytes = (b"\x00\x00" * int(0.09 * sample_rate))

    def remaining_pcm() -> Iterator[bytes]:
        for text_chunk in text_chunks[1:]:
            wave, chunk_rate = _generate(
                payload.model_copy(update={"input": text_chunk, "stream": False}), spec
            )
            if chunk_rate != sample_rate:
                raise RuntimeError(
                    "Qwen3-TTS changed sample rate during a streaming response"
                )
            yield gap_bytes
            yield _pcm16_stream_block(wave, chunk_rate)

    if payload.response_format == "pcm":
        def pcm_body() -> Iterator[bytes]:
            collected = [first_pcm]
            yield first_pcm
            for part in remaining_pcm():
                collected.append(part)
                yield part
            if payload.debug or _DEBUG_ALWAYS:
                try:
                    _debug_dump(request_id, "pcm", b"".join(collected))
                except Exception:
                    pass

        return StreamingResponse(pcm_body(), media_type=media_type, headers=headers)

    process = subprocess.Popen(
        _stream_encoder_command(payload.response_format, payload.speed, sample_rate),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=0,
    )

    def feed() -> None:
        try:
            _write_all(process.stdin, first_pcm)
            for pcm in remaining_pcm():
                _write_all(process.stdin, pcm)
        except Exception:
            pass
        finally:
            try:
                process.stdin.close()
            except Exception:
                pass

    debug_chunks: list[bytes] = []

    def encoded_body() -> Iterator[bytes]:
        worker = threading.Thread(target=feed, daemon=True)
        worker.start()
        try:
            framer = _Mp3Framer() if payload.response_format == "mp3" else None
            fd = process.stdout.fileno()
            while True:
                piece = os.read(fd, 65536)
                if not piece:
                    break
                if framer is not None:
                    for block in framer.feed(piece):
                        if payload.debug or _DEBUG_ALWAYS:
                            debug_chunks.append(block)
                        yield block
                else:
                    if payload.debug or _DEBUG_ALWAYS:
                        debug_chunks.append(piece)
                    yield piece
            if framer is not None:
                tail = framer.flush()
                if tail:
                    if payload.debug or _DEBUG_ALWAYS:
                        debug_chunks.append(tail)
                    yield tail
        finally:
            try:
                process.kill()
            except Exception:
                pass
            if (payload.debug or _DEBUG_ALWAYS) and debug_chunks:
                try:
                    _debug_dump(request_id, payload.response_format, b"".join(debug_chunks))
                except Exception as _e:
                    print(f"[debug] dump failed: {_e}", flush=True)

    return StreamingResponse(encoded_body(), media_type=media_type, headers=headers)


@app.post("/v1/audio/speech")
def speech(payload: SpeechRequest) -> Response:
    spec = _resolve_model(payload.model)
    if payload.voice and _voice_path(payload.voice).is_file():
        spec = next(item for item in MODEL_SPECS if item.kind == "voice_clone")
    request_id = "speech-" + uuid.uuid4().hex

    cleaned = _normalize_tts_text(payload.input)
    print(
        f"[speech] id={request_id} model={spec.id} stream={payload.stream} "
        f"chunk={payload.stream_chunk_chars} chars={len(cleaned)} text={cleaned[:40]!r}",
        flush=True,
    )
    if not cleaned:
        # 纯标点或空白：返回 200ms 静音，避免业务侧报错中断
        import numpy as _np

        silence = _np.zeros(int(0.2 * 24000), dtype=_np.float32)
        audio = _encode_audio(_wav_bytes(silence, 24000), payload.response_format,
                              payload.speed, 24000)
        print(f"[speech] id={request_id} 输入无实义文本，返回静音", flush=True)
        return Response(
            content=audio,
            media_type=FORMAT_MEDIA_TYPES[payload.response_format],
            headers={
                "Content-Disposition": f'inline; filename="{request_id}.{payload.response_format}"',
                "X-AI-Stack-Model": spec.id,
                "X-AI-Stack-Sample-Rate": "24000",
                "X-Request-Id": request_id,
                "X-AI-Stack-Silence": "empty-input",
            },
        )
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
        if payload.debug or _DEBUG_ALWAYS:
            try:
                _debug_dump(request_id, payload.response_format, audio)
            except Exception:
                pass
        return Response(
            content=audio,
            media_type=FORMAT_MEDIA_TYPES[payload.response_format],
            headers={
                "Content-Disposition": f'inline; filename="{request_id}.{payload.response_format}"',
                "X-AI-Stack-Model": spec.id,
                "X-AI-Stack-Sample-Rate": str(sample_rate),
                "X-Request-Id": request_id,
                **({"X-AI-Stack-Lexicon": quote("; ".join(_lexicon_hits(payload.input)))}
                   if _lexicon_hits(payload.input) else {}),
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
