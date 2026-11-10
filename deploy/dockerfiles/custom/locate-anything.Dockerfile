ARG PYTORCH_BASE_IMAGE=nvcr.io/nvidia/pytorch:25.04-py3
FROM ${PYTORCH_BASE_IMAGE}

WORKDIR /app
ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1

RUN python -m pip install --no-cache-dir \
    "fastapi>=0.116.1" \
    "uvicorn[standard]>=0.35.0" \
    "pydantic==2.11.2" \
    "transformers==4.57.1" \
    "peft>=0.15.0" \
    "lmdb==1.7.5" \
    "python-multipart>=0.0.9"

COPY deploy/templates/decord.py /app/decord.py
COPY deploy/templates/ai_stack_locate_server.py /app/ai_stack_locate_server.py

EXPOSE 8000
CMD ["python", "-m", "ai_stack_locate_server", "--host", "0.0.0.0", "--port", "8000"]
