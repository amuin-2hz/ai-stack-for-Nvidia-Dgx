#!/usr/bin/env bash
#
# SPDX-FileCopyrightText: Copyright (c) 1993-2025 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${AI_STACK_BASE:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
MODELS_DIR="$BASE_DIR/models"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python || command -v python3)}"
VENV_DIR="$BASE_DIR/.model-download-venv"
MODELSCOPE_BIN=""
MODELSCOPE_CACHE="${MODELSCOPE_CACHE:-$BASE_DIR/cache/modelscope}"

mkdir -p "$MODELS_DIR" "$MODELSCOPE_CACHE/.lock"

ensure_python_deps() {
  if "$PYTHON_BIN" -c "import modelscope" >/dev/null 2>&1; then
    MODELSCOPE_BIN="$(dirname "$PYTHON_BIN")/modelscope"
    return
  fi

  if [ ! -x "$VENV_DIR/bin/python" ]; then
    python3 -m venv "$VENV_DIR"
  fi

  "$VENV_DIR/bin/pip" install --upgrade pip
  "$VENV_DIR/bin/pip" install modelscope
  PYTHON_BIN="$VENV_DIR/bin/python"
  MODELSCOPE_BIN="$VENV_DIR/bin/modelscope"
}

is_ready_file() {
  local file_path="$1"
  [ -s "$file_path" ]
}

download_marker_path() {
  local target_dir="$1"
  echo "$target_dir/.download-complete"
}

download_ms_file() {
  repo_id="$1"
  remote_file="$2"
  target_dir="$3"
  rename_to="$4"
  local destination="$target_dir/$rename_to"

  if is_ready_file "$destination"; then
    echo "Skipping $rename_to, already downloaded."
    return
  fi

  "$MODELSCOPE_BIN" download --model "$repo_id" --local_dir "$target_dir" "$remote_file"

  "$PYTHON_BIN" - "$remote_file" "$target_dir" "$rename_to" <<'PY'
from pathlib import Path
import shutil
import sys

remote_file, target_dir, rename_to = sys.argv[1:]
target = Path(target_dir)
target.mkdir(parents=True, exist_ok=True)
matches = [path for path in target.rglob("*") if path.is_file() and path.name == remote_file]
if not matches:
    raise SystemExit(f"Failed to find downloaded file {remote_file} in {target}")
source = matches[0]
destination = target / rename_to
if source.resolve() != destination.resolve():
    if destination.exists():
        destination.unlink()
    shutil.move(str(source), str(destination))
PY
}

download_ms_snapshot() {
  repo_id="$1"
  target_dir="$2"
  local marker_file
  marker_file="$(download_marker_path "$target_dir")"

  if [ -f "$marker_file" ]; then
    rm -rf "$target_dir/.temp"
    echo "Skipping $target_dir, already downloaded."
    return
  fi

  rm -f "$marker_file"
  rm -rf "$target_dir/.temp"
  "$MODELSCOPE_BIN" download --model "$repo_id" --local_dir "$target_dir"
  rm -rf "$target_dir/.temp"
  touch "$marker_file"
}

ensure_python_deps

export MODELSCOPE_CACHE

echo "Downloading Q4 GGUF models from ModelScope into $MODELS_DIR ..."
download_ms_file "unsloth/Qwen3-8B-GGUF" "Qwen3-8B-Q4_K_M.gguf" "$MODELS_DIR" "Qwen3-8B-Q4_K_M.gguf"
download_ms_file "qwen/Qwen2.5-Coder-7B-Instruct-GGUF" "qwen2.5-coder-7b-instruct-q4_k_m.gguf" "$MODELS_DIR" "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf"
download_ms_file "Qwen/Qwen3-Embedding-4B-GGUF" "Qwen3-Embedding-4B-Q4_K_M.gguf" "$MODELS_DIR" "Qwen3-Embedding-4B-Q4_K_M.gguf"
download_ms_file "Qwen/Qwen3-VL-8B-Instruct-GGUF" "Qwen3VL-8B-Instruct-Q4_K_M.gguf" "$MODELS_DIR" "Qwen3-VL-8B-Instruct-Q4_K_M.gguf"
download_ms_file "Qwen/Qwen3-VL-8B-Instruct-GGUF" "mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf" "$MODELS_DIR" "Qwen3-VL-8B-Instruct-mmproj-Q8_0.gguf"

echo "Downloading audio models into $MODELS_DIR ..."
download_ms_snapshot "FunAudioLLM/Fun-ASR-MLT-Nano-2512" "$MODELS_DIR/fun-asr-mlt-nano-2512"
download_ms_snapshot "iic/CosyVoice-300M-SFT" "$MODELS_DIR/cosyvoice-300m-sft"

echo "All Q4, ASR, and TTS models downloaded from ModelScope."
