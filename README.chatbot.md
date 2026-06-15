# Chatbot Spark: A Local Multi-Agent System for DGX Spark 

## Project Overview

Chatbot Spark is a fully local multi-agent system built on DGX Spark. With 128GB of unified memory, DGX Spark can run multiple quantized LLMs and VLMs in parallel while keeping the deployment practical for local development.

At the core is a supervisor agent powered by a Q4-quantized Qwen3-8B model, orchestrating specialized downstream agents for coding, retrieval-augmented generation (RAG), and image understanding. Thanks to DGX Spark’s out-of-the-box support for popular AI frameworks and libraries, development and prototyping were fast and frictionless. Together, these components demonstrate how complex, multimodal workflows can be executed efficiently on local, high-performance hardware.

> **Note**: This repository now defaults to Q4 GGUF models to reduce disk and VRAM pressure while preserving multi-agent capability.

This project was built to be customizable, serving as a framework that developers can customize. 

## Key Features
  - **MCP Server Integration**: Chatbot Spark also showcases the ability to connect to custom MCP servers through a simple and customizable multi-server client

  - **Tool Calling**: This project uses an agents-as-tools framework and showcases the ability to create additional agents connected as tools. General tools can also be added.

  - **Easily Swappable Models**: Models are loaded and served using Llama CPP and Ollama and served through the OpenAI API. Any OpenAI-compatible model can be integrated into the project.

  - **Vector Indexing & Retrieval**: GPU-accelerated Milvus for high-performance document retrieval.

  - **Real-time LLM Streaming**: We present custom LLM-streaming infrastructure, making it easy for developers to stream supervisor responses from any OpenAI compatible model. 

  - **Real-time Audio Streaming**: A dedicated `audio-service` now exposes a Bailian-style WebSocket protocol for streaming ASR/TTS with FunASR and CosyVoice-compatible adapters.

  - **Q4-First Deployment**: The default chat, coding, embedding, and VLM stack uses Q4 GGUF models so the full system is much easier to download and run locally.


## System Overview
<img src="assets/system-diagram.png" alt="System Diagram" style="max-width:600px;border-radius:5px;justify-content:center">

## Default Models
| Model                        | Quantization | Model Type | VRAM        |
|------------------------------|--------------|------------|-------------|
| Qwen3:8B                     | Q4_K_M       | Chat       | ~ 5 GB      |
| Qwen2.5-Coder:7B-Instruct    | Q4_K_M       | Coding     | ~ 4.5 GB    |
| Qwen3-VL:8B-Instruct         | Q4_K_M       | Image      | ~ 5.5 GB    |
| Qwen3-Embedding:4B           | Q4_K_M       | Embedding  | ~ 2.5 GB    |
| Fun-ASR-MLT-Nano-2512        | FP16         | ASR        | on demand    |
| CosyVoice-300M-SFT           | FP16         | TTS        | on demand    |

**Total resident GGUF footprint:** ~17.5 GB + ASR/TTS on demand

> **Warning**:
> The VLM and audio models still require GPU memory when loaded, but the default stack is dramatically smaller than the previous `gpt-oss-120b + bf16 VL` setup.

---

## Quick Start
#### 1. Clone the repository and change directories to the multi-agent chatbot directory.

#### 2. Configure docker permissions
```bash
sudo usermod -aG docker $USER
newgrp docker
```

> **Warning**: After running usermod, you may need to reboot using `sudo reboot` to start a new
> session with updated group permissions.

#### 3. Run the model download script
The setup script now downloads the lighter Q4 GGUF stack plus the audio models used by `audio-service`, and it pulls everything from `https://www.modelscope.cn`. It pulls:
- `Qwen3-8B-Q4_K_M.gguf`
- `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`
- `Qwen3-Embedding-4B-Q4_K_M.gguf`
- `Qwen3-VL-8B-Instruct-Q4_K_M.gguf`
- `Qwen3-VL-8B-Instruct-mmproj-Q8_0.gguf`
- `Fun-ASR-MLT-Nano-2512`
- `CosyVoice-300M-SFT`

The GGUF files are stored under `assets/models/`, while ASR/TTS model folders are stored under the repository root `models/`.
```bash
chmod +x model_download.sh
./model_download.sh
```

#### 4. Start the docker containers for the application
This step builds the base llama cpp server image, the `audio-service` based on `nvcr.io/nvidia/pytorch:25.04-py3`, and starts all the required docker services to serve models, the backend API server as well as the frontend UI. This step can take 10 to 20 minutes depending on network speed.
```bash
docker compose -f deploy/compose/docker compose.yml -f deploy/compose/docker compose-models.yml up -d --build
```
> Note: The `qwen3-vl` container may take longer to become healthy on first startup because it also loads the `mmproj` file.

#### 4.1 Audio endpoints
- Backend audio gateway: `ws://localhost:8000/ws/audio/<chat_id>`
- Dedicated realtime audio service: `ws://localhost:9000/ws/realtime`
- Model progress API: `http://localhost:8000/models/progress`
- Audio model metadata: `http://localhost:8000/audio/models`

Wait for all the containers to become ready and healthy. 
```bash
watch 'docker ps --format "table {{.ID}}\t{{.Names}}\t{{.Status}}"'
```

>**Note**: If any of the model downloads fail, change directories to the `models/` directory and delete the problematic file and start from step 3 again.
```bash
cd models/
rm -rf <model_file>
./model_download.sh
```

#### 3.1 Check audio model download progress
Use the repository-level inspector to verify which root-level ASR/TTS model folders are complete and which ones still contain `.incomplete` or `.lock` remnants.
```bash
python3 /home/zhenz/ai-stack/ops/scripts/check_models_progress.py
```

#### 5. Access the frontend UI

Open your browser and go to: [http://localhost:3000](http://localhost:3000)

> Note:  If you are running this on a remote GPU via an ssh connection, in a new terminal window, you need to run to be able to access the UI at localhost:3000 and for the UI to be able to communicate to the backend at localhost:8000:
>```bash
> ssh -L 3000:localhost:3000 -L 8000:localhost:8000  username@IP-address
>```

You should see the following UI in your browser:
<img src="assets/multi-agent-chatbot.png" alt="Frontend UI" style="max-width:600px;border-radius:5px;justify-content:center">

### 6. Try out the sample prompts
Click on any of the tiles on the frontend to try out the supervisor and the other agents.

#### RAG Agent:
Before trying out the example prompt for the RAG agent, upload the example PDF document [NVIDIA Blackwell Whitepaper](https://images.nvidia.com/aem-dam/Solutions/geforce/blackwell/nvidia-rtx-blackwell-gpu-architecture.pdf) as context by going to the link, downloading the PDF to the local filesystem, clicking on the green "Upload Documents" button in the left sidebar under "Context" and then make sure to check the box in the "Select Sources" section.

<img src="assets/document-ingestion.png" alt="Ingest Documents" style="max-width:300px;border-radius:5px;justify-content:center">

> **Note**: You may upload any PDF of your choice, and ask corresponding queries. The default prompt requires the NVIDIA Blackwell Whitepaper.

#### Image Understanding Agent:

**Example Prompt:**

Describe this image: https://en.wikipedia.org/wiki/London_Bridge#/media/File:London_Bridge_from_St_Olaf_Stairs.jpg


## Cleanup

Follow these steps to completely remove the containers and free up resources.

From the root directory of the multi-agent-chatbot project, run the following commands:

```bash
docker compose -f deploy/compose/docker compose.yml -f deploy/compose/docker compose-models.yml down

docker volume rm "$(basename "$PWD")_postgres_data"
sudo sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'
```
You can optionally run `docker volume prune` to remove all unused volumes at the end of the demo.
> **Note**: If you do not execute these commands containers, will continue to run and take up memory.

## Customizations

### Using different models

You can swap the supervisor, coding, or VLM model to another GGUF quant as long as the filename and service name stay aligned.

1. Update `model_download.sh` to pull the alternative GGUF quant or model repo.
2. Update the corresponding model path in `deploy/compose/docker compose-models.yml`.
3. If you are changing the supervisor model, update the `MODELS` environment variable in `deploy/compose/docker compose.yml`.
4. If you are changing the coding or VLM service names, also update:
   - `legacy/python-backend/tools/mcp_servers/code_generation.py`
   - `legacy/python-backend/tools/mcp_servers/image_understanding.py`

### Adding MCP servers and tools

1. You can add more MCP servers and tools under [legacy/python-backend/tools/mcp_servers](legacy/python-backend/tools/mcp_servers/) following existing examples.

2. If you added an MCP server, remember to add it to the server configs in [legacy/python-backend/client.py](legacy/python-backend/client.py)
