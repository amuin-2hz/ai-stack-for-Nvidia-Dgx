"""OpenAI-compatible VibeVoice-ASR-HF adapter."""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import tempfile
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import FastAPI, HTTPException, Request

app = FastAPI(title="AI Stack VibeVoice HF", version="0.1.0")
_model_state: dict[str, Any] = {"processor": None, "model": None, "device": None, "dtype": None}
_model_lock = Lock()


def _model_path() -> str:
    return os.environ.get("VIBEVOICE_RUNTIME_MODEL", "/models/vibevoice-asr-hf")


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {
        "status": "ok",
        "model": os.environ.get("VIBEVOICE_MODEL", "vibevoice"),
        "path": _model_path(),
        "available": Path(_model_path()).exists(),
        "loaded": _model_state["model"] is not None,
    }


@app.get("/v1/models")
def models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [{
            "id": os.environ.get("VIBEVOICE_MODEL", "vibevoice"),
            "object": "model",
            "owned_by": "ai-stack",
            "path": _model_path(),
        }],
    }


def _torch_dtype(torch: Any) -> Any:
    configured = os.environ.get("VIBEVOICE_DTYPE", "auto").lower()
    if configured in {"bf16", "bfloat16"}:
        return torch.bfloat16
    if configured in {"fp16", "float16"}:
        return torch.float16
    if configured in {"fp32", "float32"}:
        return torch.float32
    return torch.bfloat16 if torch.cuda.is_available() else torch.float32


def _load_model() -> tuple[Any, Any, Any, Any]:
    if _model_state["model"] is not None:
        return _model_state["processor"], _model_state["model"], _model_state["device"], _model_state["dtype"]
    model_path = _model_path()
    if not Path(model_path).exists():
        raise HTTPException(status_code=503, detail=f"VibeVoice model path not found: {model_path}")
    import torch
    from transformers import AutoProcessor, VibeVoiceAsrForConditionalGeneration

    dtype = _torch_dtype(torch)
    device = os.environ.get("VIBEVOICE_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
    processor = AutoProcessor.from_pretrained(model_path, local_files_only=True, trust_remote_code=True)
    model = VibeVoiceAsrForConditionalGeneration.from_pretrained(
        model_path,
        torch_dtype=dtype,
        device_map="auto" if device == "cuda" else None,
        local_files_only=True,
        trust_remote_code=True,
    )
    if device != "cuda":
        model = model.to(device)
    model.eval()
    _model_state.update({"processor": processor, "model": model, "device": device, "dtype": dtype})
    return processor, model, device, dtype


def _message_parts(payload: dict[str, Any]) -> tuple[str, str | None]:
    audio_url = None
    prompt_parts: list[str] = []
    for message in payload.get("messages", []):
        content = message.get("content")
        if isinstance(content, str):
            prompt_parts.append(content)
            continue
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "text":
                prompt_parts.append(str(item.get("text", "")))
            if item.get("type") == "audio_url":
                audio = item.get("audio_url") or {}
                audio_url = audio.get("url")
    if not audio_url:
        raise HTTPException(status_code=400, detail="messages must contain an audio_url item")
    prompt = "\n".join(part for part in prompt_parts if part).strip() or None
    return audio_url, prompt


def _write_audio(audio_url: str) -> str:
    if not audio_url.startswith("data:"):
        raise HTTPException(status_code=400, detail="Only base64 data URL audio_url values are enabled for this adapter")
    header, _, encoded = audio_url.partition(",")
    if not encoded:
        raise HTTPException(status_code=400, detail="Invalid data URL")
    media_type = header.split(";", 1)[0].removeprefix("data:")
    suffix = ".wav"
    if "mp4" in media_type or "m4a" in media_type:
        suffix = ".m4a"
    elif "mpeg" in media_type or "mp3" in media_type:
        suffix = ".mp3"
    payload = base64.b64decode(encoded)
    handle = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        handle.write(payload)
        return handle.name
    finally:
        handle.close()


def _json_content(parsed: Any, raw: Any) -> str:
    if isinstance(parsed, list):
        return json.dumps(parsed, ensure_ascii=False)
    if isinstance(raw, list):
        raw = raw[0] if raw else ""
    text = str(raw)
    match = re.search(r"\[[\s\S]*\]", text)
    if match:
        candidate = match.group(0)
        try:
            json.loads(candidate)
            return candidate
        except Exception:
            pass
    return text


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> dict[str, Any]:
    payload = await request.json()
    expected_model = os.environ.get("VIBEVOICE_MODEL", "vibevoice")
    if payload.get("model") not in {None, expected_model}:
        raise HTTPException(status_code=400, detail=f"Unsupported model: {payload.get('model')}")
    audio_url, prompt = _message_parts(payload)
    audio_path = _write_audio(audio_url)
    try:
        with _model_lock:
            processor, model, _device, dtype = _load_model()
            inputs = processor.apply_transcription_request(audio=audio_path, prompt=prompt).to(model.device, dtype)
            generate_kwargs: dict[str, Any] = {"do_sample": False}
            max_tokens = payload.get("max_tokens")
            if isinstance(max_tokens, int) and max_tokens > 0:
                generate_kwargs["max_new_tokens"] = max_tokens
            chunk_size = os.environ.get("VIBEVOICE_TOKENIZER_CHUNK_SIZE")
            if chunk_size:
                generate_kwargs["tokenizer_chunk_size"] = int(chunk_size)
            output_ids = model.generate(**inputs, **generate_kwargs)
            generated_ids = output_ids[:, inputs["input_ids"].shape[1] :]
            parsed = processor.decode(generated_ids, return_format="parsed")[0]
            raw = processor.decode(generated_ids)[0]
        content = _json_content(parsed, raw)
        return {
            "id": "chatcmpl-vibevoice",
            "object": "chat.completion",
            "model": expected_model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        }
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"VibeVoice inference failed: {error}") from error
    finally:
        Path(audio_path).unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
