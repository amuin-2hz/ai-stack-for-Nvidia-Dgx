ARG PYTORCH_BASE_IMAGE=nvcr.io/nvidia/pytorch:25.04-py3
FROM ${PYTORCH_BASE_IMAGE}

WORKDIR /app
ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/cache/huggingface \
    MODELSCOPE_CACHE=/cache/modelscope \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        libsox-fmt-all \
        sox \
    && rm -rf /var/lib/apt/lists/*

# qwen-tts 0.1.1 pins the matching Transformers/Accelerate runtime used by
# the released Qwen3-TTS checkpoints. API packages are pinned for repeatable builds.
RUN python -m pip install --no-cache-dir \
    "qwen-tts==0.1.1" \
    "fastapi==0.116.1" \
    "uvicorn==0.35.0" \
    && python -m pip install --no-cache-dir --force-reinstall --no-deps \
        "torchaudio==2.7.0"

COPY deploy/templates/ai_stack_qwen3_tts_server.py /app/ai_stack_qwen3_tts_server.py

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)" || exit 1

CMD ["python", "-m", "ai_stack_qwen3_tts_server", "--host", "0.0.0.0", "--port", "8000"]
