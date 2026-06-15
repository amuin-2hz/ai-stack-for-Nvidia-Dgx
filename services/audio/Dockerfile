FROM nvcr.io/nvidia/pytorch:25.04-py3

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y sox libsox-dev && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    fastapi>=0.116.1 \
    uvicorn>=0.35.0 \
    pydantic>=2.11.7 \
    websockets>=15.0.1 \
    numpy>=1.26.4 \
    soundfile>=0.12.1 \
    modelscope>=1.24.0

# whisper for ASR (model loaded from mounted cache at runtime)
RUN pip install --no-cache-dir openai-whisper>=20250625

# edge-tts for TTS (calls Microsoft TTS API, no local model needed)
RUN pip install --no-cache-dir edge-tts>=7.0.0

COPY . .

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9000"]
