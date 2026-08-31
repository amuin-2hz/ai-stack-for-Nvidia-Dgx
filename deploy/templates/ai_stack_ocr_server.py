"""OpenAI-compatible Unlimited-OCR service using the model's custom infer API."""
from __future__ import annotations

import argparse
import base64
import io
import os
import tempfile
import logging
from pathlib import Path
from threading import Lock
from typing import Any

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from PIL import Image
from starlette.concurrency import run_in_threadpool
from transformers import AutoModel, AutoTokenizer


logger = logging.getLogger("ai-stack.unlimited-ocr")


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[dict[str, Any]] = Field(default_factory=list)
    max_tokens: int = Field(default=4096, ge=1, le=28672)


app = FastAPI(title="AI Stack Unlimited-OCR", version="1.0.0")
_state: dict[str, Any] = {"model": None, "tokenizer": None, "model_path": None}
_inference_lock = Lock()


def _decode_data_url(value: str) -> Image.Image:
    if not value.startswith("data:image") or "," not in value:
        raise ValueError("Only data:image/*;base64 URLs are supported by the local OCR runtime.")
    payload = value.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(payload))).convert("RGB")


def _extract_prompt_and_image(messages: list[dict[str, Any]]) -> tuple[str, Image.Image]:
    prompt_parts: list[str] = []
    image: Image.Image | None = None
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            prompt_parts.append(content)
            continue
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                prompt_parts.append(str(part.get("text", "")))
            if part.get("type") == "image_url" and image is None:
                image_url = part.get("image_url") or {}
                try:
                    image = _decode_data_url(str(image_url.get("url", "")))
                except (ValueError, base64.binascii.Error) as error:
                    raise HTTPException(status_code=400, detail=str(error)) from error
    if image is None:
        raise HTTPException(status_code=400, detail="A base64 data image_url is required.")
    prompt = "\n".join(item for item in prompt_parts if item).strip() or "document parsing."
    return prompt, image


def load_runtime(model_path: str) -> tuple[Any, Any]:
    if _state["model"] is not None and _state["model_path"] == model_path:
        return _state["model"], _state["tokenizer"]
    tokenizer = AutoTokenizer.from_pretrained(
        model_path,
        trust_remote_code=True,
        local_files_only=True,
    )
    model = AutoModel.from_pretrained(
        model_path,
        trust_remote_code=True,
        local_files_only=True,
        use_safetensors=True,
        dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
    ).eval().cuda()
    _state.update({"model": model, "tokenizer": tokenizer, "model_path": model_path})
    return model, tokenizer


def _infer(model_path: str, prompt: str, image: Image.Image, max_tokens: int) -> str:
    with tempfile.TemporaryDirectory(prefix="unlimited-ocr-") as output_dir:
        image_path = Path(output_dir) / "input.png"
        image.save(image_path)
        with _inference_lock:
            model, tokenizer = load_runtime(model_path)
            output = model.infer(
                tokenizer,
                prompt=f"<image>{prompt}",
                image_file=str(image_path),
                output_path=output_dir,
                base_size=1024,
                image_size=640,
                crop_mode=True,
                # OpenAI max_tokens is an output budget; the custom model API
                # expects total sequence length, including visual/input tokens.
                max_length=min(32768, max_tokens + 4096),
                no_repeat_ngram_size=35,
                ngram_window=128,
                save_results=False,
                eval_mode=True,
            )
    return str(output).strip()


@app.on_event("startup")
def load_model_on_startup() -> None:
    load_runtime(os.environ.get("MODEL_PATH", "/models/unlimited-ocr"))


@app.get("/healthz")
def healthz() -> dict[str, str]:
    if _state["model"] is None:
        raise HTTPException(status_code=503, detail="OCR model is still loading.")
    return {"status": "ok"}


@app.get("/runtime")
def runtime() -> dict[str, Any]:
    model_path = os.environ.get("MODEL_PATH", "/models/unlimited-ocr")
    return {
        "runtime": "unlimited-ocr",
        "components": ["PyTorch", "HuggingFace Transformers", "Unlimited-OCR custom code"],
        "model_path": model_path,
        "model_available": Path(model_path).exists(),
        "model_loaded": _state["model"] is not None,
    }


@app.get("/v1/models")
def models() -> dict[str, Any]:
    if _state["model"] is None:
        raise HTTPException(status_code=503, detail="OCR model is still loading.")
    model_id = os.environ.get("OPENAI_MODEL", "unlimited-ocr")
    return {"object": "list", "data": [{"id": model_id, "object": "model", "owned_by": "ai-stack"}]}


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatRequest) -> dict[str, Any]:
    model_path = os.environ.get("MODEL_PATH", "/models/unlimited-ocr")
    model_id = request.model or os.environ.get("OPENAI_MODEL", "unlimited-ocr")
    prompt, image = _extract_prompt_and_image(request.messages)
    try:
        text = await run_in_threadpool(_infer, model_path, prompt, image, request.max_tokens)
    except (OSError, RuntimeError, ValueError) as error:
        logger.exception("Unlimited-OCR inference failed")
        raise HTTPException(status_code=500, detail=str(error)) from error
    return {
        "id": "ai-stack-unlimited-ocr",
        "object": "chat.completion",
        "model": model_id,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=os.environ.get("MODEL_PATH", "/models/unlimited-ocr"))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    os.environ["MODEL_PATH"] = args.model
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
