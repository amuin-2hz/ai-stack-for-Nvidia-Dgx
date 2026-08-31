ARG PYTORCH_BASE_IMAGE=nvcr.io/nvidia/pytorch:25.04-py3
FROM ${PYTORCH_BASE_IMAGE}

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

RUN pip install --no-cache-dir \
    fastapi>=0.116.1 \
    uvicorn>=0.35.0 \
    pydantic>=2.11.7

COPY pytorch_env.py .

CMD ["uvicorn", "pytorch_env:app", "--host", "0.0.0.0", "--port", "9000"]
