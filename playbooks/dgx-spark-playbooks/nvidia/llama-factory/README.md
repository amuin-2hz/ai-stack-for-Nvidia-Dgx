# LLaMA Factory

> Install and fine-tune models with LLaMA Factory

## Table of Contents

- [Overview](#overview)
- [Instructions](#instructions)
- [Troubleshooting](#troubleshooting)

---

## Overview

## Basic idea
LLaMA Factory is an open-source framework that simplifies the process of training and fine
tuning large language models. It offers a unified interface for a variety of cutting edge
methods such as SFT, RLHF, and QLoRA techniques. It also supports a wide range of LLM
architectures such as LLaMA, Mistral and Qwen. This playbook demonstrates how to fine-tune
large language models using LLaMA Factory CLI on your NVIDIA Spark device.

## What you'll accomplish

You'll set up LLaMA Factory on NVIDIA Spark with Blackwell architecture to fine-tune large
language models using LoRA, QLoRA, and full fine-tuning methods. This enables efficient
model adaptation for specialized domains while leveraging hardware-specific optimizations.

## What to know before starting

- Basic Python knowledge for editing config files and troubleshooting
- Command line usage for running shell commands and managing environments
- Familiarity with PyTorch and Hugging Face Transformers ecosystem
- GPU environment setup including CUDA/cuDNN installation and VRAM management
- Fine-tuning concepts: understanding tradeoffs between LoRA, QLoRA, and full fine-tuning
- Dataset preparation: formatting text data into JSON structure for instruction tuning
- Resource management: adjusting batch size and memory settings for GPU constraints

## Prerequisites

- NVIDIA Spark device with Blackwell architecture

- CUDA 12.9 or newer version installed: `nvcc --version`

- Git installed: `git --version`

- Python 3 with venv and pip: `python3 --version && pip3 --version`

- Sufficient storage space (>50GB for models and checkpoints): `df -h`

- Internet connection for downloading models from Hugging Face Hub

## Ancillary files

- Official LLaMA Factory repository: https://github.com/hiyouga/LLaMA-Factory

- PyTorch with CUDA 13: install via `pip3 install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130`

- Example training configuration: `examples/train_lora/qwen3_lora_sft.yaml` (from repository)

- Documentation: https://llamafactory.readthedocs.io/en/latest/getting_started/data_preparation.html

## Time & risk

* **Duration:** 30-60 minutes for initial setup, 1-7 hours for training depending on model size and dataset.
* **Risks:** Model downloads require significant bandwidth and storage. Training may consume substantial GPU memory and require parameter tuning for hardware constraints.
* **Rollback:** Deactivate the virtual environment and remove the `factoryEnv` and `LLaMA-Factory` directories. Training checkpoints are saved locally and can be deleted to reclaim storage space.
* **Last Updated:** 02/18/2026
  * Updated to venv-based setup with PyTorch CUDA 13 (no Docker). Qwen3 LoRA fine-tuning workflow.

## Instructions

## Step 1. Verify system prerequisites

Check that your NVIDIA Spark system has the required components installed and accessible.

```bash
nvcc --version
nvidia-smi
python3 --version
git --version
```

## Step 2. Create and activate a Python virtual environment

Create a virtual environment and activate it for the LLaMA Factory installation.

```bash
python3 -m venv factoryEnv
source ./factoryEnv/bin/activate
```

## Step 3. Install PyTorch with CUDA 13 support

Install PyTorch, torchvision, and torchaudio with CUDA 13.0 support from the official PyTorch index.

```bash
pip3 install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130
```

## Step 4. Verify PyTorch CUDA support

Confirm that PyTorch can see the GPU.

```bash
python -c "import torch; print(f'PyTorch: {torch.__version__}, CUDA: {torch.cuda.is_available()}')"
```

## Step 5. Clone LLaMA Factory repository

Download the LLaMA Factory source code from the official repository.

```bash
git clone --depth 1 https://github.com/hiyouga/LLaMA-Factory.git
cd LLaMA-Factory
```

## Step 6. Install LLaMA Factory with dependencies

Install LLaMA Factory in editable mode with metrics support.

```bash
pip install -e ".[metrics]"
```

## Step 7. Prepare training configuration

Examine the provided LoRA fine-tuning configuration for Qwen3.

```bash
cat examples/train_lora/qwen3_lora_sft.yaml
```

## Step 8. Launch fine-tuning training

> [!NOTE]
> Login to your Hugging Face Hub to download the model if the model is gated.

Execute the training process using the pre-configured LoRA setup.

```bash
hf auth login   # if the model is gated
llamafactory-cli train examples/train_lora/qwen3_lora_sft.yaml
```

Example output:
```
***** train metrics *****
  epoch                    =        3.0
  total_flos               = 11076559GF
  train_loss               =     0.9993
  train_runtime            = 0:14:32.12
  train_samples_per_second =      3.749
  train_steps_per_second   =      0.471
Figure saved at: saves/qwen3-4b/lora/sft/training_loss.png
```

## Step 9. Validate training completion

Verify that training completed successfully and checkpoints were saved.

```bash
ls -la saves/qwen3-4b/lora/sft/
```

Expected output should show:
- Final checkpoint directory (`checkpoint-411` or similar)
- Model configuration files (`adapter_config.json`)
- Training metrics showing decreasing loss values
- Training loss plot saved as PNG file

## Step 10. Test inference with fine-tuned model

Test your fine-tuned model with custom prompts:

```bash
llamafactory-cli chat examples/inference/qwen3_lora_sft.yaml
## Type: "Hello, how can you help me today?"
## Expect: Response showing fine-tuned behavior
```

## Step 11. For production deployment, export your model

```bash
llamafactory-cli export examples/merge_lora/qwen3_lora_sft.yaml
```

## Step 12. Cleanup and rollback

> [!WARNING]
> This will delete all training progress and checkpoints.

To remove the virtual environment and cloned repository:

```bash
deactivate
cd ..
rm -rf LLaMA-Factory/
rm -rf factoryEnv/
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|--------|-----|
| CUDA out of memory during training | Batch size too large for GPU VRAM | Reduce `per_device_train_batch_size` or increase `gradient_accumulation_steps` |
| Cannot access gated repo for URL | Certain HuggingFace models have restricted access | Regenerate your [HuggingFace token](https://huggingface.co/docs/hub/en/security-tokens); and request access to the [gated model](https://huggingface.co/docs/hub/en/models-gated#customize-requested-information) on your web browser |
| Model download fails or is slow | Network connectivity or Hugging Face Hub issues | Check internet connection, try using `HF_HUB_OFFLINE=1` for cached models |
| Training loss not decreasing | Learning rate too high/low or insufficient data | Adjust `learning_rate` parameter or check dataset quality |

> [!NOTE]
> DGX Spark uses a Unified Memory Architecture (UMA), which enables dynamic memory sharing between the GPU and CPU. 
> With many applications still updating to take advantage of UMA, you may encounter memory issues even when within 
> the memory capacity of DGX Spark. If that happens, manually flush the buffer cache with:
```bash
sudo sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'
```
