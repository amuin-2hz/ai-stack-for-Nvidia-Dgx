"""FunASR gateway matching the NVIDIA speech deployment acceptance API."""
from __future__ import annotations

import argparse
import os
import re
import tempfile
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

app = FastAPI(title="AI Stack FunASR Gateway", version="0.1.0")
_asr_state: dict[str, Any] = {"id": None, "model": None}
_diarization_state: dict[str, Any] = {"id": None, "model": None, "backend": None}
_asr_lock = Lock()
_diarization_lock = Lock()


def _device() -> str:
    return os.environ.get("MODEL_DEVICE", "cuda")


def _runtime_path(env_name: str, fallback: str) -> Path:
    configured = os.environ.get(env_name)
    return Path(configured) if configured else Path("/models") / fallback


def _path_available(path: Path) -> bool:
    return path.exists() and (not path.is_dir() or any(path.iterdir()))


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


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "provider": os.environ.get("MODEL_PROVIDER", "funasr"),
        "device": _device(),
        "downloadOnStartup": os.environ.get("MODEL_DOWNLOAD_ON_STARTUP", "false").lower() == "true",
        "models": {
            "asr": _model_health("ASR_RUNTIME_MODEL", "ASR_MODEL_ID", "sensevoicesmall", _asr_state),
            "asrVad": _model_health("ASR_VAD_RUNTIME_MODEL", "ASR_VAD_MODEL_ID", "speech_fsmn_vad_zh-cn-16k-common-pytorch"),
            "diarizationAsr": _model_health(
                "DIARIZATION_ASR_RUNTIME_MODEL",
                "DIARIZATION_ASR_MODEL_ID",
                "speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
            ),
            "diarizationPunc": _model_health(
                "DIARIZATION_PUNC_RUNTIME_MODEL",
                "DIARIZATION_PUNC_MODEL_ID",
                "punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
            ),
            "diarization": _model_health("DIARIZATION_RUNTIME_MODEL", "DIARIZATION_MODEL_ID", "speech_campplus_sv_zh-cn_16k-common", _diarization_state),
            "fullDiarizationFallback": _model_health(
                "FULL_DIARIZATION_RUNTIME_MODEL",
                "FULL_DIARIZATION_MODEL_ID",
                "speech_campplus_speaker-diarization_common",
                _diarization_state,
            ),
        },
    }


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


def _load_asr_model() -> Any:
    model_path = _runtime_path("ASR_RUNTIME_MODEL", "sensevoicesmall")
    if _asr_state["model"] is not None and _asr_state["id"] == str(model_path):
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
    runtime = AutoModel(**kwargs)
    _asr_state.update({"id": str(model_path), "model": runtime})
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

        runtime = pipeline(task="speaker-diarization", model=str(selected_path))
        _diarization_state.update({"id": str(selected_path), "model": runtime, "backend": "modelscope-pipeline"})
        return runtime

    from funasr import AutoModel

    runtime = AutoModel(model=str(selected_path), device=_device(), disable_update=True)
    _diarization_state.update({"id": str(selected_path), "model": runtime, "backend": "funasr"})
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


@app.post("/transcription/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form(default="auto"),
    speakerCount: str = Form(default="auto"),
) -> dict[str, Any]:
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty.")
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
            handle.write(payload)
            temp_path = handle.name
        duration = _duration_seconds(temp_path)
        with _asr_lock:
            asr = _load_asr_model()
            asr_result = asr.generate(input=temp_path, batch_size_s=int(os.environ.get("ASR_BATCH_SIZE_SECONDS", "300")))
        asr_segments = _asr_segments(asr_result, language, duration)

        try:
            with _diarization_lock:
                diarization = _load_diarization_model()
                if _diarization_state.get("backend") == "modelscope-pipeline":
                    kwargs = {}
                    if speakerCount and speakerCount != "auto":
                        kwargs["oracle_num"] = int(speakerCount)
                    diarization_result = diarization(temp_path, **kwargs)
                else:
                    diarization_result = diarization.generate(input=temp_path)
            diarization_segments = _diarization_segments(diarization_result, duration)
        except Exception as error:
            diarization_segments = [{"speakerLabel": "SPEAKER_00", "start": 0.0, "end": duration, "error": str(error)}]

        return {"asrSegments": asr_segments, "diarizationSegments": diarization_segments}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {error}") from error
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8011)
    args = parser.parse_args()
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
