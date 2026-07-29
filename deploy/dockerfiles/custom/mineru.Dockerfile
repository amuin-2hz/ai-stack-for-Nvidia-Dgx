ARG PYTORCH_BASE_IMAGE=nvcr.io/nvidia/pytorch:25.04-py3
FROM ${PYTORCH_BASE_IMAGE}

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV HF_HOME=/cache/huggingface
ENV MODELSCOPE_CACHE=/cache/modelscope

RUN python -m pip install --no-cache-dir \
    "fastapi>=0.116.1" \
    "uvicorn[standard]>=0.35.0" \
    "pydantic==2.11.2" \
    "pillow>=10.4.0" \
    "pymupdf>=1.24.9" \
    "python-multipart>=0.0.9" \
    "transformers>=4.56.0,<5" \
    "mineru-vl-utils[transformers]"


COPY deploy/templates/ai_stack_document_server.py /app/ai_stack_document_server.py

EXPOSE 8000
CMD ["python", "-m", "ai_stack_document_server", "--host", "0.0.0.0", "--port", "8000"]
