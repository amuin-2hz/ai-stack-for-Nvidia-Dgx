#!/usr/bin/env python3
"""Inspect local model directories and report download completeness."""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable


PROJECT_ROOT = Path(__file__).resolve().parents[2]
MODELS_DIR = PROJECT_ROOT / "models"
HF_CACHE_DIR = PROJECT_ROOT / "cache" / "hf" / "hub"
ESSENTIAL_CONFIGS = {
    "config.json",
    "configuration.json",
    "config.yaml",
    "cosyvoice.yaml",
    "tokenizer.json",
    "tokenizer_config.json",
}
WEIGHT_SUFFIXES = (".safetensors", ".bin", ".gguf", ".pt", ".pth", ".onnx", ".engine", ".fst")


@dataclass
class ModelProgress:
    model: str
    path: str
    status: str
    weight_files: int
    total_weight_bytes: int
    config_files: list[str]
    incomplete_files: list[str]
    lock_files: list[str]
    notes: list[str]


def iter_dirs(path: Path) -> Iterable[Path]:
    if not path.exists():
        return []
    return sorted([entry for entry in path.iterdir() if entry.is_dir()])


def collect_files(base: Path, pattern: str) -> list[Path]:
    return sorted(base.rglob(pattern)) if base.exists() else []


def detect_status(weight_files: list[Path], config_names: set[str], incomplete: list[Path], locks: list[Path]) -> tuple[str, list[str]]:
    notes: list[str] = []
    if incomplete:
        notes.append("存在 .incomplete 文件，下载未完成。")
    if locks:
        notes.append("存在 .lock 文件，可能有残留下载锁。")

    if not weight_files:
        notes.append("未发现权重文件。")
    if not ESSENTIAL_CONFIGS.intersection(config_names):
        notes.append("缺少核心配置文件。")

    if incomplete:
        return "incomplete", notes
    if weight_files and ESSENTIAL_CONFIGS.intersection(config_names):
        if locks:
            return "mostly_ready_with_locks", notes
        return "ready", notes
    return "pending", notes


def summarize_model(model_dir: Path) -> ModelProgress:
    all_files = [path for path in model_dir.rglob("*") if path.is_file()]
    weight_files = [path for path in all_files if path.suffix in WEIGHT_SUFFIXES or any(path.name.endswith(suffix) for suffix in WEIGHT_SUFFIXES)]
    incomplete = [path for path in all_files if ".incomplete" in path.name]
    locks = [path for path in all_files if path.suffix == ".lock"]
    config_names = {path.name for path in all_files}
    status, notes = detect_status(weight_files, config_names, incomplete, locks)

    return ModelProgress(
        model=model_dir.name,
        path=str(model_dir),
        status=status,
        weight_files=len(weight_files),
        total_weight_bytes=sum(path.stat().st_size for path in weight_files),
        config_files=sorted(config_names.intersection(ESSENTIAL_CONFIGS)),
        incomplete_files=[str(path.relative_to(model_dir)) for path in incomplete[:20]],
        lock_files=[str(path.relative_to(model_dir)) for path in locks[:20]],
        notes=notes,
    )


def summarize_cache() -> dict[str, dict[str, int]]:
    summary: dict[str, dict[str, int]] = {}
    for cache_dir in iter_dirs(HF_CACHE_DIR):
        blobs = collect_files(cache_dir / "blobs", "*")
        incomplete = [path for path in blobs if path.name.endswith(".incomplete")]
        summary[cache_dir.name] = {
            "blob_count": len(blobs),
            "incomplete_blob_count": len(incomplete),
        }
    return summary


def main() -> None:
    results = [summarize_model(model_dir) for model_dir in iter_dirs(MODELS_DIR)]
    payload = {
        "models_dir": str(MODELS_DIR),
        "model_count": len(results),
        "models": [asdict(item) for item in results],
        "hf_cache": summarize_cache(),
    }
    print(json.dumps(payload, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
