"""LocateAnything visual-grounding runtime using the model's Transformers worker."""
from __future__ import annotations

import argparse
import base64
import io
import os
import re
from pathlib import Path
from threading import Lock
from typing import Any, Literal

import torch
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from transformers import AutoConfig, AutoModel, AutoProcessor, AutoTokenizer


class GroundRequest(BaseModel):
    image_url: str
    prompt: str
    generation_mode: Literal["fast", "slow", "hybrid"] = "hybrid"
    max_new_tokens: int = Field(default=512, ge=32, le=8192)
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)


app = FastAPI(title="AI Stack LocateAnything", version="1.0.0")
_state: dict[str, Any] = {"path": None, "tokenizer": None, "processor": None, "model": None, "error": None}
_inference_lock = Lock()


def _model_path() -> str:
    return os.environ.get("MODEL_PATH", "/models/locateanything-3b")


def _decode_image(value: str) -> Image.Image:
    if not value.startswith("data:image") or "," not in value:
        raise ValueError("Only data:image/*;base64 URLs are supported.")
    try:
        return Image.open(io.BytesIO(base64.b64decode(value.split(",", 1)[1]))).convert("RGB")
    except Exception as error:
        raise ValueError("Invalid base64 image payload.") from error


def _load_runtime() -> tuple[Any, Any, Any]:
    model_path = _model_path()
    if _state["model"] is not None and _state["path"] == model_path:
        return _state["tokenizer"], _state["processor"], _state["model"]
    if not Path(model_path).exists():
        raise RuntimeError(f"Model not found: {model_path}")
    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True, local_files_only=True)
    processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True, local_files_only=True)
    config = AutoConfig.from_pretrained(model_path, trust_remote_code=True, local_files_only=True)
    config._attn_implementation = "sdpa"
    config.text_config._attn_implementation = "sdpa"
    config.vision_config._attn_implementation = "sdpa"
    model = AutoModel.from_pretrained(
        model_path,
        config=config,
        dtype=torch.bfloat16,
        trust_remote_code=True,
        local_files_only=True,
        low_cpu_mem_usage=True,
        device_map={"": "cuda"},
    ).eval()
    _state.update({"path": model_path, "tokenizer": tokenizer, "processor": processor, "model": model, "error": None})
    return tokenizer, processor, model


def _parse_boxes(answer: str, width: int, height: int) -> list[dict[str, float]]:
    boxes = []
    for match in re.finditer(r"<box><(\d+)><(\d+)><(\d+)><(\d+)></box>", answer):
        x1, y1, x2, y2 = [int(value) for value in match.groups()]
        boxes.append({"x1": x1 / 1000 * width, "y1": y1 / 1000 * height, "x2": x2 / 1000 * width, "y2": y2 / 1000 * height})
    return boxes


def _parse_points(answer: str, width: int, height: int) -> list[dict[str, float]]:
    points = []
    for match in re.finditer(r"<box><(\d+)><(\d+)></box>", answer):
        x, y = [int(value) for value in match.groups()]
        points.append({"x": x / 1000 * width, "y": y / 1000 * height})
    return points


def _predict(request: GroundRequest) -> dict[str, Any]:
    image = _decode_image(request.image_url)
    messages = [{"role": "user", "content": [{"type": "image", "image": image}, {"type": "text", "text": request.prompt}]}]
    with _inference_lock, torch.inference_mode():
        tokenizer, processor, model = _load_runtime()
        text = processor.py_apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        images, videos = processor.process_vision_info(messages)
        inputs = processor(text=[text], images=images, videos=videos, return_tensors="pt").to("cuda")
        response = model.generate(
            pixel_values=inputs["pixel_values"].to(torch.bfloat16),
            input_ids=inputs["input_ids"],
            attention_mask=inputs["attention_mask"],
            image_grid_hws=inputs.get("image_grid_hws"),
            tokenizer=tokenizer,
            max_new_tokens=request.max_new_tokens,
            use_cache=True,
            generation_mode=request.generation_mode,
            temperature=request.temperature,
            do_sample=request.temperature > 0,
            top_p=0.9,
            repetition_penalty=1.1,
            verbose=False,
        )
    answer = response[0] if isinstance(response, tuple) else response
    if isinstance(answer, list):
        answer = answer[0] if answer else ""
    answer = str(answer)
    width, height = image.size
    return {"model": os.environ.get("OPENAI_MODEL", "locateanything-3b"), "answer": answer, "width": width, "height": height, "boxes": _parse_boxes(answer, width, height), "points": _parse_points(answer, width, height)}


@app.on_event("startup")
def load_model_on_startup() -> None:
    try:
        _load_runtime()
    except Exception as error:
        _state["error"] = str(error)
        raise


@app.get("/healthz")
def healthz() -> dict[str, str]:
    if _state["model"] is None:
        raise HTTPException(status_code=503, detail=_state["error"] or "Model is still loading.")
    return {"status": "ready", "model": os.environ.get("OPENAI_MODEL", "locateanything-3b")}


@app.get("/v1/models")
def models() -> dict[str, Any]:
    model_id = os.environ.get("OPENAI_MODEL", "locateanything-3b")
    if _state["model"] is None:
        raise HTTPException(status_code=503, detail=_state["error"] or "Model is still loading.")
    return {"object": "list", "data": [{"id": model_id, "object": "model", "owned_by": "ai-stack"}]}


@app.post("/v1/ground")
async def ground(request: GroundRequest) -> dict[str, Any]:
    try:
        return await run_in_threadpool(_predict, request)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except (OSError, RuntimeError) as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=_model_path())
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    os.environ["MODEL_PATH"] = args.model
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
