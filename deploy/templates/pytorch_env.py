"""Generic PyTorch runtime environment health service."""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI

app = FastAPI(title="AI Stack PyTorch Environment", version="0.1.0")


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "runtime": "pytorch"}


@app.get("/runtime")
async def runtime():
    import torch

    return {
        "runtime": "pytorch",
        "torch": torch.__version__,
        "cuda_available": torch.cuda.is_available(),
        "cuda_device_count": torch.cuda.device_count(),
        "models_root": os.getenv("MODELS_ROOT", "/models"),
        "cache_root": os.getenv("CACHE_ROOT", "/cache"),
    }


@app.get("/models")
async def models():
    root = Path(os.getenv("MODELS_ROOT", "/models"))
    if not root.exists():
        return {"models": []}
    return {"models": sorted(path.name for path in root.iterdir() if path.is_dir())}
