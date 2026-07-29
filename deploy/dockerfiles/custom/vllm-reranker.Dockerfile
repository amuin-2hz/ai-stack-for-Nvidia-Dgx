ARG VLLM_BASE_IMAGE=vllm/vllm-openai:latest
FROM ${VLLM_BASE_IMAGE}

WORKDIR /workspace
ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/root/.cache/huggingface
ENV TRANSFORMERS_TRUST_REMOTE_CODE=1

COPY deploy/templates/qwen3_reranker_score.jinja /workspace/qwen3_reranker_score.jinja

EXPOSE 8000
ENTRYPOINT ["python3", "-m", "vllm.entrypoints.openai.api_server"]
