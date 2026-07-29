# Newly Downloaded Model Validation

Date: 2026-07-12
Host: NVIDIA GB10

## Scope

Recently downloaded models not present in the previous custom-container validation matrix:

- OmniCoder-9B
- LocateAnything-3B

Qwen3 Embedding and Reranker were already validated in the previous run. The older qwen36-35b-a3b directory remains outside this new-download scope.

## Results

Both new models passed real inference through the host LAN address.

- OmniCoder-9B loaded through vLLM 0.23 and generated an is_prime implementation. The generated code was checked with an AST allowlist, a two-second timeout, and eight passing assertions.
- LocateAnything-3B loaded through the dedicated Transformers runtime. Slow and default Hybrid modes both located the Status: READY text in the correct lower region of the test image.

## Changes

- Updated the default vLLM Compose to pass --model explicitly and run fully offline.
- Added a LocateAnything Dockerfile, Compose profile, FastAPI grounding service, and runtime metadata.
- Forced SDPA across the composite LocateAnything config to avoid its unsupported FlashAttention text-generation path.
- Added an explicit image-only decord compatibility module for ARM64; video requests are not exposed.

## Limitations

LocateAnything is licensed for non-commercial research use. The ARM64 runtime currently supports images only because no decord 0.6 wheel exists for Python 3.12 ARM64.

All test containers were stopped after validation. Built images and templates remain available.
