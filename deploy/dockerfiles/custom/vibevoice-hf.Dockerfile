ARG PYTORCH_BASE_IMAGE=nvcr.io/nvidia/pytorch:25.04-py3
FROM ${PYTORCH_BASE_IMAGE}

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV HF_HOME=/cache/huggingface
ENV MODELSCOPE_CACHE=/cache/modelscope
ENV TRANSFORMERS_TRUST_REMOTE_CODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir \
    "fastapi>=0.116.1" \
    "uvicorn[standard]>=0.35.0" \
    "pydantic==2.11.2" \
    "python-multipart>=0.0.9" \
    "soundfile>=0.12.1" \
    "librosa>=0.10.2" \
    "accelerate>=1.8.0" \
    "transformers>=5.3.0"

COPY deploy/templates/ai_stack_vibevoice_hf_server.py /app/ai_stack_vibevoice_hf_server.py

EXPOSE 8000
CMD ["python", "-m", "ai_stack_vibevoice_hf_server", "--host", "0.0.0.0", "--port", "8000"]
