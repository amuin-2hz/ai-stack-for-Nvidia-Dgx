ARG PYTORCH_BASE_IMAGE=nvcr.io/nvidia/pytorch:25.04-py3
FROM ${PYTORCH_BASE_IMAGE}

WORKDIR /app
ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV TRANSFORMERS_TRUST_REMOTE_CODE=1

RUN python -m pip install --no-cache-dir \
    "fastapi>=0.116.1" \
    "uvicorn[standard]>=0.35.0" \
    "pydantic==2.11.2" \
    "transformers==4.57.1" \
    "accelerate>=1.5.1" \
    "safetensors>=0.4.5" \
    "pillow==11.1.0" \
    "python-multipart>=0.0.9" \
    "addict==2.4.0" \
    "easydict==1.13" \
    "einops==0.8.1" \
    "matplotlib==3.10.1" \
    "pymupdf>=1.27.2.2" \
    "psutil==7.0.0" \
    "sentencepiece>=0.2.0" \
    "protobuf==4.24.4"

COPY deploy/templates/ai_stack_ocr_server.py /app/ai_stack_ocr_server.py

EXPOSE 8000
CMD ["python", "-m", "ai_stack_ocr_server", "--host", "0.0.0.0", "--port", "8000"]
