# Audio Service

This service provides a realtime audio event layer for ASR and TTS.

## Goals

- Accept streaming PCM audio over WebSocket.
- Emit transcription events using a Bailian-style event schema.
- Return streaming audio chunks for TTS generation.
- Keep ASR/TTS runtimes swappable behind a stable protocol.

## Default model plan

- ASR: `FunAudioLLM/Fun-ASR-MLT-Nano-2512`
- TTS: `iic/CosyVoice-300M-SFT`

## Notes

- The websocket route is `/ws/realtime`.
- The current FunASR adapter can run with the Python package when installed.
- The current CosyVoice adapter keeps the streaming contract stable and uses a
  mock audio fallback until the final inference mode is fixed.
- In production, place this service behind Nginx or another reverse proxy so
  clients connect through `wss://`.
