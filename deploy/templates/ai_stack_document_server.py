"""MinerU document parsing runtime backed by the local vision-language model."""
from __future__ import annotations

import argparse
import io
import os
from pathlib import Path
from threading import Lock
from typing import Any

import fitz
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image
from starlette.concurrency import run_in_threadpool

app = FastAPI(title="AI Stack MinerU Document Parser", version="1.0.0")
_state: dict[str, Any] = {"path": None, "client": None}
_inference_lock = Lock()


def _model_path() -> Path:
    return Path(os.environ.get("MODEL_PATH", "/models/mineru2.5-pro-2605-1.2b"))


def _load_client() -> Any:
    model_path = _model_path()
    if _state["client"] is not None and _state["path"] == str(model_path):
        return _state["client"]
    if not model_path.exists():
        raise RuntimeError(f"Model not found: {model_path}")

    from mineru_vl_utils import MinerUClient
    from transformers import AutoProcessor, Qwen2VLForConditionalGeneration

    model = Qwen2VLForConditionalGeneration.from_pretrained(
        str(model_path),
        dtype="auto",
        device_map="auto",
        local_files_only=True,
        low_cpu_mem_usage=True,
    )
    processor = AutoProcessor.from_pretrained(
        str(model_path),
        use_fast=True,
        local_files_only=True,
    )
    client = MinerUClient(
        backend="transformers",
        model=model,
        processor=processor,
        image_analysis=False,
    )
    _state.update({"path": str(model_path), "client": client})
    return client


def _images_from_payload(payload: bytes, filename: str, max_pages: int) -> list[Image.Image]:
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        document = fitz.open(stream=payload, filetype="pdf")
        images: list[Image.Image] = []
        for page in list(document)[:max_pages]:
            pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            images.append(Image.open(io.BytesIO(pixmap.tobytes("png"))).convert("RGB"))
        document.close()
        return images
    try:
        return [Image.open(io.BytesIO(payload)).convert("RGB")]
    except Exception as error:
        raise ValueError("Upload a PDF or a supported image file.") from error


def _parse_payload(payload: bytes, filename: str, max_pages: int) -> dict[str, Any]:
    from mineru_vl_utils.post_process import json2md

    images = _images_from_payload(payload, filename, max_pages)
    if not images:
        raise ValueError("The document has no pages.")
    with _inference_lock:
        client = _load_client()
        page_results = [client.two_step_extract(image) for image in images]
    markdown_pages = [json2md(result) for result in page_results]
    return {
        "filename": filename,
        "pages": len(markdown_pages),
        "markdown": "\n\n".join(markdown_pages),
    }


@app.on_event("startup")
def load_model_on_startup() -> None:
    _load_client()


@app.get("/healthz")
def healthz() -> dict[str, str]:
    if _state["client"] is None:
        raise HTTPException(status_code=503, detail="MinerU model is still loading.")
    return {"status": "ok"}


@app.get("/runtime")
def runtime() -> dict[str, Any]:
    model_path = _model_path()
    return {
        "runtime": "mineru-document",
        "components": ["PyTorch", "Transformers", "MinerU VL Utils"],
        "model_path": str(model_path),
        "model_available": model_path.exists(),
        "model_loaded": _state["client"] is not None,
        "cache_root": os.environ.get("CACHE_ROOT", "/cache"),
    }


@app.get("/v1/models")
def models() -> dict[str, Any]:
    if _state["client"] is None:
        raise HTTPException(status_code=503, detail="MinerU model is still loading.")
    return {
        "object": "list",
        "data": [{"id": _model_path().name, "object": "model", "owned_by": "ai-stack"}],
    }


@app.post("/v1/documents/parse")
async def parse_document(
    file: UploadFile = File(...),
    max_pages: int = Form(default=10, ge=1, le=50),
) -> dict[str, Any]:
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Document is empty.")
    try:
        return await run_in_threadpool(
            _parse_payload,
            payload,
            file.filename or "document",
            max_pages,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=os.environ.get("MODEL_PATH", "/models/mineru2.5-pro-2605-1.2b"))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    os.environ["MODEL_PATH"] = args.model
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
