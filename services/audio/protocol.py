"""Bailian-style realtime event helpers."""

from __future__ import annotations

import base64
import uuid
from typing import Any


def make_event(event_type: str, **payload: Any) -> dict[str, Any]:
    event = {"event_id": payload.pop("event_id", f"event_{uuid.uuid4().hex}"), "type": event_type}
    event.update(payload)
    return event


def encode_audio_chunk(audio_bytes: bytes) -> str:
    return base64.b64encode(audio_bytes).decode("utf-8")
