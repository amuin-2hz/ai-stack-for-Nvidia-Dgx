"""FunASR gateway matching the NVIDIA speech deployment acceptance API."""
from __future__ import annotations

import argparse
import asyncio
import base64
import logging
import os
import re
import tempfile
import uuid
import wave
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect

app = FastAPI(title="AI Stack FunASR Gateway", version="0.1.0")
logger = logging.getLogger("ai_stack_funasr_gateway")
_asr_state: dict[str, Any] = {"key": None, "engine": None, "model": None}
_diarization_state: dict[str, Any] = {"id": None, "model": None, "backend": None}
_asr_lock = Lock()
_diarization_lock = Lock()

ASR_ENGINES = {
    "sensevoice": {
        "label": "SenseVoice",
        "model_env": "SENSEVOICE_RUNTIME_MODEL",
        "model_id_env": "SENSEVOICE_MODEL_ID",
        "fallback": "sensevoicesmall",
    },
    "paraformer": {
        "label": "Paraformer",
        "model_env": "PARAFORMER_RUNTIME_MODEL",
        "model_id_env": "PARAFORMER_MODEL_ID",
        "fallback": "speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    },
}

ASR_PRESETS = {
    "general": {
        "label": "普通转写",
        "description": "VAD + SenseVoice",
        "engine": "sensevoice",
        "lm": "none",
        "punctuation": False,
        "diarization": False,
    },
    "accurate-zh": {
        "label": "高准确率中文转写",
        "description": "VAD + Paraformer + N-gram-FST + PUNC",
        "engine": "paraformer",
        "lm": "ngram-fst",
        "punctuation": True,
        "diarization": False,
    },
    "domain-zh": {
        "label": "固定领域转写",
        "description": "VAD + Paraformer + N-gram-FST + PUNC",
        "engine": "paraformer",
        "lm": "ngram-fst",
        "punctuation": True,
        "diarization": False,
    },
    "meeting": {
        "label": "会议转写",
        "description": "ASR 管线 + 说话人分离",
        "engine": "paraformer",
        "lm": "none",
        "punctuation": True,
        "diarization": True,
    },
}



def _device() -> str:
    return os.environ.get("MODEL_DEVICE", "cuda")


def _runtime_path(env_name: str, fallback: str) -> Path:
    configured = os.environ.get(env_name)
    return Path(configured) if configured else Path("/models") / fallback


def _path_available(path: Path) -> bool:
    return path.exists() and (not path.is_dir() or any(path.iterdir()))


def _normalize_engine(value: str | None) -> str:
    normalized = str(value or "").strip().lower().replace("_", "-")
    aliases = {"sensevoicesmall": "sensevoice", "sense-voice": "sensevoice", "paraformer-zh": "paraformer"}
    normalized = aliases.get(normalized, normalized)
    if normalized not in ASR_ENGINES:
        raise HTTPException(status_code=400, detail=f"Unknown ASR engine: {value}")
    return normalized


def _pipeline_configuration(
    preset_name: str,
    engine_override: str | None = None,
    diarization_override: bool | None = None,
) -> dict[str, Any]:
    preset_key = str(preset_name or "general").strip().lower()
    if preset_key not in ASR_PRESETS:
        raise HTTPException(status_code=400, detail=f"Unknown ASR preset: {preset_name}")
    preset = ASR_PRESETS[preset_key]
    engine = _normalize_engine(engine_override or str(preset["engine"]))
    engine_meta = ASR_ENGINES[engine]
    model_path = _runtime_path(str(engine_meta["model_env"]), str(engine_meta["fallback"]))
    vad_path = _runtime_path("ASR_VAD_RUNTIME_MODEL", "speech_fsmn_vad_zh-cn-16k-common-pytorch")
    punc_path = _runtime_path("PUNC_RUNTIME_MODEL", "punc_ct-transformer_zh-cn-common-vocab272727-pytorch")
    ngram_lm_path = _runtime_path("NGRAM_LM_RUNTIME_MODEL", "speech_ngram_lm_zh-cn-ai-wesp-fst")
    requested_lm = str(preset["lm"])
    effective_lm = requested_lm
    warnings: list[str] = []
    execution = "python"
    available = _path_available(model_path) and _path_available(vad_path)

    if engine == "sensevoice" and requested_lm != "none":
        effective_lm = "none"
        warnings.append("SenseVoice entry does not use Paraformer language-model fusion.")
    if engine == "paraformer" and bool(preset["punctuation"]) and not _path_available(punc_path):
        available = False
        warnings.append(f"Punctuation model is missing: {punc_path}")
    if engine == "paraformer" and requested_lm == "ngram-fst":
        execution = "runtime-sdk"
        runtime_url = os.environ.get("NGRAM_RUNTIME_URL", "").strip()
        runtime_ready = _runtime_service_available(runtime_url)
        available = available and _path_available(ngram_lm_path) and runtime_ready
        if not _path_available(ngram_lm_path):
            warnings.append(f"N-gram FST model is missing: {ngram_lm_path}")
        if not runtime_ready:
            warnings.append("N-gram FST runtime-SDK service is not ready.")

    include_diarization = bool(preset["diarization"]) if diarization_override is None else bool(diarization_override)
    return {
        "id": preset_key,
        "label": preset["label"],
        "description": preset["description"],
        "engine": engine,
        "engineLabel": engine_meta["label"],
        "modelPath": str(model_path),
        "execution": execution,
        "requestedLm": requested_lm,
        "effectiveLm": effective_lm,
        "punctuation": engine == "paraformer" and bool(preset["punctuation"]),
        "diarization": include_diarization,
        "available": available,
        "warnings": warnings,
    }


def _pipeline_catalog() -> list[dict[str, Any]]:
    return [_pipeline_configuration(preset_name) for preset_name in ASR_PRESETS]


def _runtime_service_available(url: str) -> bool:
    if not url:
        return False
    try:
        import socket
        from urllib.parse import urlparse

        parsed = urlparse(url)
        if not parsed.hostname or not parsed.port:
            return False
        with socket.create_connection((parsed.hostname, parsed.port), timeout=0.25):
            return True
    except OSError:
        return False


def _ensure_modelscope_cache_link(model_id: str, source_path: Path) -> None:
    if not _path_available(source_path):
        return
    cache_root = Path(os.environ.get("MODELSCOPE_CACHE", "/cache/modelscope"))
    target = cache_root / "models" / model_id.replace("/", "--") / "snapshots" / "master"
    if _path_available(target):
        return
    if target.exists() or target.is_symlink():
        return
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(source_path, target_is_directory=True)
    except OSError:
        return


def _model_health(env_name: str, id_env_name: str, fallback_id: str, state: dict[str, Any] | None = None) -> dict[str, Any]:
    path = _runtime_path(env_name, fallback_id)
    return {
        "id": os.environ.get(id_env_name, fallback_id),
        "path": str(path),
        "available": _path_available(path),
        "loaded": bool(state and state.get("model") is not None),
    }


def _cuda_memory() -> dict[str, Any]:
    try:
        import torch

        if not torch.cuda.is_available():
            return {"available": False}
        free_bytes, total_bytes = torch.cuda.mem_get_info()
        stats = torch.cuda.memory_stats()
        return {
            "available": True,
            "device": torch.cuda.get_device_name(0),
            "freeBytes": free_bytes,
            "totalBytes": total_bytes,
            "allocatedBytes": torch.cuda.memory_allocated(),
            "reservedBytes": torch.cuda.memory_reserved(),
            "maxAllocatedBytes": torch.cuda.max_memory_allocated(),
            "maxReservedBytes": torch.cuda.max_memory_reserved(),
            "activeBytes": stats.get("active_bytes.all.current", 0),
            "inactiveSplitBytes": stats.get("inactive_split_bytes.all.current", 0),
            "segments": stats.get("segment.all.current", 0),
            "allocationRetries": stats.get("num_alloc_retries", 0),
            "ooms": stats.get("num_ooms", 0),
        }
    except Exception as error:
        return {"available": False, "error": str(error)}


def _log_cuda_memory(stage: str) -> None:
    logger.info("CUDA memory stage=%s stats=%s", stage, _cuda_memory())


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "provider": os.environ.get("MODEL_PROVIDER", "funasr"),
        "device": _device(),
        "downloadOnStartup": os.environ.get("MODEL_DOWNLOAD_ON_STARTUP", "false").lower() == "true",
        "models": {
            "sensevoice": _model_health("SENSEVOICE_RUNTIME_MODEL", "SENSEVOICE_MODEL_ID", "sensevoicesmall", _asr_state if _asr_state.get("engine") == "sensevoice" else None),
            "paraformer": _model_health("PARAFORMER_RUNTIME_MODEL", "PARAFORMER_MODEL_ID", "speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch", _asr_state if _asr_state.get("engine") == "paraformer" else None),
            "vad": _model_health("ASR_VAD_RUNTIME_MODEL", "ASR_VAD_MODEL_ID", "speech_fsmn_vad_zh-cn-16k-common-pytorch"),
            "punctuation": _model_health("PUNC_RUNTIME_MODEL", "PUNC_MODEL_ID", "punc_ct-transformer_zh-cn-common-vocab272727-pytorch"),
            "ngramLm": _model_health("NGRAM_LM_RUNTIME_MODEL", "NGRAM_LM_MODEL_ID", "speech_ngram_lm_zh-cn-ai-wesp-fst"),
            "diarization": _model_health("DIARIZATION_RUNTIME_MODEL", "DIARIZATION_MODEL_ID", "speech_campplus_sv_zh-cn_16k-common", _diarization_state),
            "fullDiarizationFallback": _model_health(
                "FULL_DIARIZATION_RUNTIME_MODEL",
                "FULL_DIARIZATION_MODEL_ID",
                "speech_campplus_speaker-diarization_common",
                _diarization_state,
            ),
        },
        "activeAsrEngine": _asr_state.get("engine"),
        "pipelines": _pipeline_catalog(),
    }



@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    engines = [
        {
            "id": engine,
            "object": "model",
            "owned_by": "funasr",
            "kind": "asr-engine",
            "label": meta["label"],
            "available": _path_available(_runtime_path(str(meta["model_env"]), str(meta["fallback"]))),
        }
        for engine, meta in ASR_ENGINES.items()
    ]
    presets = [
        {**item, "id": f"pipeline:{item['id']}", "object": "model", "owned_by": "ai-stack", "kind": "asr-preset"}
        for item in _pipeline_catalog()
    ]
    return {"object": "list", "data": engines + presets}

@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/debug/cuda-memory")
def cuda_memory() -> dict[str, Any]:
    return {
        "cuda": _cuda_memory(),
        "models": {
            "asrLoaded": _asr_state.get("model") is not None,
            "diarizationLoaded": _diarization_state.get("model") is not None,
        },
    }


def _load_asr_model(pipeline: dict[str, Any]) -> Any:
    if pipeline["execution"] != "python":
        raise HTTPException(status_code=503, detail="The selected pipeline requires FunASR runtime-SDK.")
    model_path = Path(str(pipeline["modelPath"]))
    cache_key = "|".join([
        str(pipeline["engine"]),
        str(model_path),
        str(pipeline["effectiveLm"]),
        str(pipeline["punctuation"]),
    ])
    if _asr_state["model"] is not None and _asr_state["key"] == cache_key:
        return _asr_state["model"]
    if not _path_available(model_path):
        raise HTTPException(status_code=503, detail=f"ASR model missing: {model_path}")

    from funasr import AutoModel

    kwargs: dict[str, Any] = {
        "model": str(model_path),
        "trust_remote_code": True,
        "device": _device(),
        "disable_update": True,
    }
    vad_path = _runtime_path("ASR_VAD_RUNTIME_MODEL", "speech_fsmn_vad_zh-cn-16k-common-pytorch")
    if _path_available(vad_path):
        kwargs["vad_model"] = str(vad_path)
        kwargs["vad_kwargs"] = {"max_single_segment_time": int(os.environ.get("ASR_VAD_MAX_SEGMENT_MS", "30000"))}
    if pipeline["engine"] == "paraformer" and pipeline["punctuation"]:
        punc_path = _runtime_path("PUNC_RUNTIME_MODEL", "punc_ct-transformer_zh-cn-common-vocab272727-pytorch")
        kwargs["punc_model"] = str(punc_path)

    if _asr_state.get("model") is not None:
        _asr_state.update({"key": None, "engine": None, "model": None})
        try:
            import gc
            import torch

            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
    _log_cuda_memory(f"before-{pipeline['engine']}-load")
    runtime = AutoModel(**kwargs)
    _asr_state.update({"key": cache_key, "engine": pipeline["engine"], "model": runtime})
    _log_cuda_memory(f"after-{pipeline['engine']}-load")
    return runtime


def _load_diarization_model() -> Any:
    full_path = _runtime_path("FULL_DIARIZATION_RUNTIME_MODEL", "speech_campplus_speaker-diarization_common")
    speaker_path = _runtime_path("DIARIZATION_RUNTIME_MODEL", "speech_campplus_sv_zh-cn_16k-common")
    selected_path = full_path if _path_available(full_path) else speaker_path
    if _diarization_state["model"] is not None and _diarization_state["id"] == str(selected_path):
        return _diarization_state["model"]
    if not _path_available(selected_path):
        raise HTTPException(status_code=503, detail=f"Diarization model missing: {selected_path}")

    if selected_path == full_path:
        _ensure_modelscope_cache_link("damo/speech_campplus_sv_zh-cn_16k-common", speaker_path)

        from modelscope.pipelines import pipeline

        _log_cuda_memory("before-diarization-load")
        runtime = pipeline(task="speaker-diarization", model=str(selected_path))
        _diarization_state.update({"id": str(selected_path), "model": runtime, "backend": "modelscope-pipeline"})
        _log_cuda_memory("after-diarization-load")
        return runtime

    from funasr import AutoModel

    _log_cuda_memory("before-diarization-load")
    runtime = AutoModel(model=str(selected_path), device=_device(), disable_update=True)
    _diarization_state.update({"id": str(selected_path), "model": runtime, "backend": "funasr"})
    _log_cuda_memory("after-diarization-load")
    return runtime


def _duration_seconds(file_path: str) -> float:
    try:
        import soundfile as sf

        info = sf.info(file_path)
        if info.samplerate:
            return round(info.frames / info.samplerate, 3)
    except Exception:
        pass
    return 0.0


def _clean_text(value: Any) -> str:
    return re.sub(r"<\|[^>]+\|>", "", str(value or "")).strip()


def _seconds(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if number > 10000:
        number = number / 1000.0
    return round(number, 3)


def _asr_segments(result: Any, language: str, duration: float) -> list[dict[str, Any]]:
    first = result[0] if isinstance(result, list) and result else result if isinstance(result, dict) else {}
    if not isinstance(first, dict):
        return [{"segmentId": "chunk-001", "start": 0.0, "end": duration, "text": _clean_text(first), "language": language, "wordTimestamps": []}]

    sentence_info = first.get("sentence_info")
    if isinstance(sentence_info, list) and sentence_info:
        segments = []
        for index, item in enumerate(sentence_info, start=1):
            if not isinstance(item, dict):
                continue
            segments.append({
                "segmentId": f"chunk-{index:03d}",
                "start": _seconds(item.get("start")),
                "end": _seconds(item.get("end")),
                "text": _clean_text(item.get("text")),
                "language": language,
                "wordTimestamps": item.get("timestamp") if isinstance(item.get("timestamp"), list) else [],
            })
        if segments:
            return segments

    return [{
        "segmentId": "chunk-001",
        "start": 0.0,
        "end": duration,
        "text": _clean_text(first.get("text")),
        "language": language,
        "wordTimestamps": first.get("timestamp") if isinstance(first.get("timestamp"), list) else [],
    }]


def _speaker_label(raw: Any, index: int) -> str:
    text = str(raw)
    if text.startswith("SPEAKER_"):
        return text
    if text.isdigit():
        return f"SPEAKER_{int(text):02d}"
    return f"SPEAKER_{index:02d}"


def _diarization_segments(result: Any, duration: float) -> list[dict[str, Any]]:
    candidates = result.get("text") if isinstance(result, dict) else result
    if isinstance(candidates, dict):
        candidates = candidates.get("segments") or candidates.get("text")
    segments: list[dict[str, Any]] = []
    if isinstance(candidates, list):
        for index, item in enumerate(candidates):
            if isinstance(item, dict):
                start = item.get("start") or item.get("begin") or item.get("ts")
                end = item.get("end") or item.get("stop") or item.get("te")
                speaker = item.get("speaker") or item.get("speakerLabel") or item.get("spk") or item.get("label") or index
            elif isinstance(item, (list, tuple)) and len(item) >= 3:
                start, end, speaker = item[0], item[1], item[2]
            else:
                continue
            segments.append({"speakerLabel": _speaker_label(speaker, index), "start": _seconds(start), "end": _seconds(end)})
    return segments or [{"speakerLabel": "SPEAKER_00", "start": 0.0, "end": duration}]


async def _runtime_sdk_transcribe(file_path: str) -> Any:
    import json
    import websockets

    runtime_url = os.environ.get("NGRAM_RUNTIME_URL", "").strip()
    if not runtime_url:
        raise HTTPException(status_code=503, detail="N-gram runtime-SDK service is not configured.")
    sample_rate = 16000
    wav_format = "others"
    source = Path(file_path)
    if source.suffix.lower() == ".wav":
        with wave.open(file_path, "rb") as wav_file:
            sample_rate = wav_file.getframerate()
            audio_bytes = wav_file.readframes(wav_file.getnframes())
        wav_format = "pcm"
    else:
        audio_bytes = source.read_bytes()
    chunk_bytes = max(3200, int(sample_rate * 2 * 0.06))
    timeout = float(os.environ.get("NGRAM_RUNTIME_TIMEOUT_SECONDS", "300"))
    final_payload: dict[str, Any] = {}
    async with websockets.connect(runtime_url, subprotocols=["binary"], ping_interval=None, max_size=None) as websocket:
        await websocket.send(json.dumps({
            "mode": "offline",
            "chunk_size": [5, 10, 5],
            "chunk_interval": 10,
            "audio_fs": sample_rate,
            "wav_name": source.stem or "audio",
            "wav_format": wav_format,
            "is_speaking": True,
            "hotwords": "",
            "itn": True,
        }, ensure_ascii=False))
        for offset in range(0, len(audio_bytes), chunk_bytes):
            await websocket.send(audio_bytes[offset:offset + chunk_bytes])
        await websocket.send(json.dumps({"is_speaking": False, "is_end": True}))
        try:
            while True:
                message = await asyncio.wait_for(websocket.recv(), timeout=timeout)
                payload = json.loads(message)
                has_result = isinstance(payload, dict) and bool(payload.get("text") or payload.get("sentence_info"))
                if has_result:
                    final_payload = payload
                # Offline runtime sends the complete utterance with is_final=false.
                if isinstance(payload, dict) and (
                    (has_result and payload.get("mode") == "offline")
                    or payload.get("is_final")
                    or payload.get("is_end")
                ):
                    if not final_payload:
                        final_payload = payload
                    break
        except asyncio.TimeoutError as exc:
            raise HTTPException(status_code=504, detail="N-gram runtime-SDK transcription timed out.") from exc
    if not final_payload:
        raise HTTPException(status_code=502, detail="N-gram runtime-SDK returned no transcription result.")
    return [final_payload]


def _transcribe_path(
    file_path: str,
    language: str,
    speaker_count: str,
    pipeline: dict[str, Any],
) -> dict[str, Any]:
    if not pipeline["available"]:
        detail = "; ".join(pipeline["warnings"]) or "Selected ASR pipeline is unavailable."
        raise HTTPException(status_code=503, detail=detail)
    duration = _duration_seconds(file_path)
    if pipeline["execution"] == "runtime-sdk":
        asr_result = asyncio.run(_runtime_sdk_transcribe(file_path))
    else:
        with _asr_lock:
            asr = _load_asr_model(pipeline)
            generate_kwargs: dict[str, Any] = {
                "input": file_path,
                "batch_size_s": int(os.environ.get("ASR_BATCH_SIZE_SECONDS", "300")),
            }
            if pipeline["engine"] == "sensevoice":
                generate_kwargs["language"] = language
                generate_kwargs["use_itn"] = True
            asr_result = asr.generate(**generate_kwargs)
    asr_segments = _asr_segments(asr_result, language, duration)

    if not pipeline["diarization"]:
        return {
            "text": "".join(item.get("text", "") for item in asr_segments).strip(),
            "pipeline": pipeline,
            "asrSegments": asr_segments,
            "diarizationSegments": [],
        }

    try:
        with _diarization_lock:
            diarization = _load_diarization_model()
            if _diarization_state.get("backend") == "modelscope-pipeline":
                kwargs = {}
                if speaker_count and speaker_count != "auto":
                    kwargs["oracle_num"] = int(speaker_count)
                diarization_result = diarization(file_path, **kwargs)
            else:
                diarization_result = diarization.generate(input=file_path)
        diarization_segments = _diarization_segments(diarization_result, duration)
    except Exception as error:
        diarization_segments = [{"speakerLabel": "SPEAKER_00", "start": 0.0, "end": duration, "error": str(error)}]
    return {
        "text": "".join(item.get("text", "") for item in asr_segments).strip(),
        "pipeline": pipeline,
        "asrSegments": asr_segments,
        "diarizationSegments": diarization_segments,
    }


def _write_pcm_wave(pcm: bytes, sample_rate: int, channels: int = 1) -> str:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
        temp_path = handle.name
    with wave.open(temp_path, "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm)
    return temp_path


def _transcript_text(result: dict[str, Any]) -> str:
    return "".join(str(item.get("text", "")) for item in result.get("asrSegments", [])).strip()


@app.post("/transcription/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form(default="auto"),
    speakerCount: str = Form(default="auto"),
    preset: str = Form(default="general"),
    asrEngine: str = Form(default=""),
    diarization: bool | None = Form(default=None),
) -> dict[str, Any]:
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty.")
    pipeline = _pipeline_configuration(preset, asrEngine or None, diarization)
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
            handle.write(payload)
            temp_path = handle.name
        return await asyncio.to_thread(_transcribe_path, temp_path, language, speakerCount, pipeline)
    except HTTPException:
        raise
    except Exception as error:
        _log_cuda_memory("transcription-error")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {error}") from error
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)


@app.websocket("/v1/realtime")
@app.websocket("/ws/realtime")
async def realtime(ws: WebSocket) -> None:
    await ws.accept()
    session_id = f"session_{uuid.uuid4().hex}"
    buffer = bytearray()
    sample_rate = 16000
    channels = 1
    language = "auto"
    speaker_count = "auto"
    preset_name = "general"
    asr_engine = "sensevoice"
    diarization_override: bool | None = None
    pipeline = _pipeline_configuration(preset_name, asr_engine, diarization_override)
    max_buffer_bytes = int(os.environ.get("ASR_WS_MAX_BUFFER_BYTES", str(64 * 1024 * 1024)))

    await ws.send_json({
        "type": "session.created",
        "session": {
            "id": session_id,
            "object": "realtime.session",
            "modalities": ["text"],
            "input_audio_format": {"type": "pcm16", "rate": sample_rate, "channels": channels},
            "preset": preset_name,
            "asrEngine": asr_engine,
            "diarization": pipeline["diarization"],
        },
    })

    try:
        while True:
            message = await ws.receive_json()
            event_type = message.get("type")

            if event_type == "session.update":
                config = message.get("session") if isinstance(message.get("session"), dict) else {}
                audio_format = config.get("input_audio_format") if isinstance(config.get("input_audio_format"), dict) else {}
                sample_rate = int(audio_format.get("rate", sample_rate))
                channels = max(1, int(audio_format.get("channels", channels)))
                language = str(config.get("language", language))
                speaker_count = str(config.get("speakerCount", config.get("speaker_count", speaker_count)))
                preset_name = str(config.get("preset", preset_name))
                asr_engine = str(config.get("asrEngine", config.get("asr_engine", asr_engine)))
                if "diarization" in config:
                    diarization_override = bool(config["diarization"])
                pipeline = _pipeline_configuration(preset_name, asr_engine, diarization_override)
                await ws.send_json({
                    "type": "session.updated",
                    "session": {
                        "id": session_id,
                        "modalities": ["text"],
                        "input_audio_format": {"type": "pcm16", "rate": sample_rate, "channels": channels},
                        "language": language,
                        "speakerCount": speaker_count,
                        "preset": preset_name,
                        "asrEngine": asr_engine,
                        "diarization": pipeline["diarization"],
                        "pipeline": pipeline,
                    },
                })
                continue

            if event_type == "input_audio_buffer.append":
                audio = message.get("audio", "")
                if not isinstance(audio, str) or not audio:
                    raise ValueError("input_audio_buffer.append requires base64 audio")
                chunk = base64.b64decode(audio, validate=True)
                if len(buffer) + len(chunk) > max_buffer_bytes:
                    raise ValueError(f"audio buffer exceeds {max_buffer_bytes} bytes")
                buffer.extend(chunk)
                duration_ms = round(len(buffer) / max(1, sample_rate * channels * 2) * 1000)
                await ws.send_json({"type": "input_audio_buffer.status", "bytes": len(buffer), "duration_ms": duration_ms})
                continue

            if event_type == "input_audio_buffer.clear":
                buffer.clear()
                await ws.send_json({"type": "input_audio_buffer.cleared"})
                continue

            if event_type == "input_audio_buffer.commit":
                if not buffer:
                    raise ValueError("audio buffer is empty")
                pcm = bytes(buffer)
                buffer.clear()
                item_id = f"item_{uuid.uuid4().hex}"
                await ws.send_json({"type": "input_audio_buffer.committed", "item_id": item_id})
                temp_path = _write_pcm_wave(pcm, sample_rate, channels)
                try:
                    result = await asyncio.to_thread(
                        _transcribe_path,
                        temp_path,
                        language,
                        speaker_count,
                        pipeline,
                    )
                finally:
                    Path(temp_path).unlink(missing_ok=True)
                transcript = _transcript_text(result)
                await ws.send_json({
                    "type": "conversation.item.input_audio_transcription.delta",
                    "item_id": item_id,
                    "content_index": 0,
                    "delta": transcript,
                })
                await ws.send_json({
                    "type": "conversation.item.created",
                    "item": {
                        "id": item_id,
                        "object": "realtime.item",
                        "type": "message",
                        "status": "completed",
                        "role": "user",
                        "content": [{"type": "input_audio", "transcript": transcript}],
                    },
                })
                await ws.send_json({
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": item_id,
                    "content_index": 0,
                    "transcript": transcript,
                    **result,
                })
                continue

            await ws.send_json({
                "type": "error",
                "error": {"type": "invalid_request_error", "message": f"Unknown event: {event_type}"},
            })
    except WebSocketDisconnect:
        return
    except Exception as error:
        _log_cuda_memory("websocket-error")
        try:
            await ws.send_json({
                "type": "error",
                "error": {"type": "server_error", "message": str(error)},
            })
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8011)
    args = parser.parse_args()
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
