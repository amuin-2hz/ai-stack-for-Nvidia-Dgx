ARG PYTORCH_BASE_IMAGE=nvcr.io/nvidia/pytorch:25.04-py3
FROM ${PYTORCH_BASE_IMAGE}

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV MODELSCOPE_CACHE=/cache/modelscope
ENV HF_HOME=/cache/huggingface

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 libsox-dev libsox-fmt-all \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir --no-deps "torchaudio==2.7.0"

RUN python -m pip install --no-cache-dir \
    "fastapi>=0.116.1" \
    "uvicorn[standard]>=0.35.0" \
    "pydantic==2.11.2" \
    "numpy>=1.26.0" \
    "soundfile>=0.12.1" \
    "librosa>=0.10.2" \
    "scipy>=1.13.0" \
    "modelscope>=1.27.0" \
    "funasr==1.3.30" \
    "sentencepiece>=0.2.0" \
    "addict>=2.4.0" \
    "simplejson>=3.19.0" \
    "python-multipart>=0.0.9"

RUN python -m pip install --no-cache-dir --no-build-isolation "hdbscan>=0.8.44" \
    && python -m pip install --no-cache-dir --no-deps \
        "datasets==2.21.0" \
        "pyarrow-hotfix==0.7" \
        "multiprocess>=0.70.17" \
        "xxhash>=3.0.0"

COPY deploy/templates/ai_stack_funasr_gateway.py /app/ai_stack_funasr_gateway.py

EXPOSE 8011
CMD ["python", "-m", "ai_stack_funasr_gateway", "--host", "0.0.0.0", "--port", "8011"]
