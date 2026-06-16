FROM nvcr.io/nvidia/pytorch:25.04-py3

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

RUN pip install --no-cache-dir \
    fastapi>=0.116.1 \
    uvicorn>=0.35.0 \
    pydantic>=2.11.7 \
    websockets>=15.0.1 \
    numpy>=1.26.4 \
    soundfile>=0.12.1 \
    openai-whisper>=20250625

COPY pytorch_asr.py .

CMD ["uvicorn", "pytorch_asr:app", "--host", "0.0.0.0", "--port", "9000"]
