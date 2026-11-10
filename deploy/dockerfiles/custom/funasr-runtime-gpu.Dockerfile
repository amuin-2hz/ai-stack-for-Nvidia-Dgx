ARG ARM64_RUNTIME_DEPS_IMAGE=registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-cpu-0.4.7
ARG PYTORCH_BASE_IMAGE=nvcr.io/nvidia/pytorch:25.04-py3

FROM ${ARM64_RUNTIME_DEPS_IMAGE} AS runtime-deps
FROM ${PYTORCH_BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV MODELSCOPE_CACHE=/workspace/models/.modelscope
ENV LD_LIBRARY_PATH=/workspace/onnxruntime-linux-aarch64-1.17.1/lib:/workspace/ffmpeg-master-latest-linuxarm64-gpl-shared/lib:/usr/local/lib/python3.12/dist-packages/torch/lib:${LD_LIBRARY_PATH}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        cmake \
        libssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir --no-deps "torchaudio==2.7.0" \
    && python -m pip install --no-cache-dir \
        "funasr==1.3.30" \
        "modelscope>=1.27.0" \
        "onnx>=1.17.0" \
        "sentencepiece>=0.2.0" \
        "soundfile>=0.12.1"

# Reuse the ARM64 ONNX Runtime and FFmpeg binaries from FunASR's working CPU
# image. The acoustic model itself is linked against libtorch and runs on CUDA.
COPY --from=runtime-deps /workspace/onnxruntime-linux-aarch64-1.17.1 /workspace/onnxruntime-linux-aarch64-1.17.1
COPY --from=runtime-deps /workspace/ffmpeg-master-latest-linuxarm64-gpl-shared /workspace/ffmpeg-master-latest-linuxarm64-gpl-shared
COPY --from=runtime-deps /workspace/FunASR /workspace/FunASR

# Upstream's GPU CMake file is tied to Python 3.8, the old C++ ABI and
# torch_blade. NGC 25.04 on ARM64 ships Python 3.12/PyTorch 2.7 with the new
# ABI. Use plain TorchScript so the runtime matches the host-supported stack.
RUN python - <<'PY'
from pathlib import Path

roots = [
    Path("/workspace/FunASR/runtime/websocket/CMakeLists.txt"),
    Path("/workspace/FunASR/runtime/onnxruntime/CMakeLists.txt"),
]
for path in roots:
    text = path.read_text()
    text = text.replace(
        'set(CMAKE_CXX_STANDARD 14 CACHE STRING "The C++ version to be used.")',
        'set(CMAKE_CXX_STANDARD 17 CACHE STRING "The C++ version to be used.")',
    )
    text = text.replace(
        'set(TORCH_DIR "/usr/local/lib/python3.8/dist-packages/torch")',
        'set(TORCH_DIR "/usr/local/lib/python3.12/dist-packages/torch")',
    )
    text = text.replace(
        '    set(TORCH_BLADE_DIR "/usr/local/lib/python3.8/dist-packages/torch_blade")\n',
        '',
    )
    text = text.replace('    link_directories(${TORCH_BLADE_DIR})\n', '')
    text = text.replace('-D_GLIBCXX_USE_CXX11_ABI=0', '-D_GLIBCXX_USE_CXX11_ABI=1')
    path.write_text(text)

path = Path("/workspace/FunASR/runtime/onnxruntime/src/CMakeLists.txt")
text = path.read_text().replace(
    'set(TORCH_DEPS torch torch_cuda torch_cpu c10 c10_cuda torch_blade ral_base_context)',
    'set(TORCH_DEPS torch torch_cuda torch_cpu c10 c10_cuda)',
)
path.write_text(text)
PY

RUN cmake \
        -S /workspace/FunASR/runtime/websocket \
        -B /workspace/FunASR/runtime/websocket/build-gpu \
        -DCMAKE_BUILD_TYPE=Release \
        -DGPU=ON \
        -DENABLE_PORTAUDIO=OFF \
        -DONNXRUNTIME_DIR=/workspace/onnxruntime-linux-aarch64-1.17.1 \
        -DFFMPEG_DIR=/workspace/ffmpeg-master-latest-linuxarm64-gpl-shared \
    && cmake --build /workspace/FunASR/runtime/websocket/build-gpu \
        --target funasr-wss-server \
        --parallel 4

WORKDIR /workspace/FunASR/runtime
EXPOSE 10095
