import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path


class _FastAPI:
    def __init__(self, **_kwargs):
        pass

    def get(self, *_args, **_kwargs):
        return lambda function: function

    post = get
    websocket = get


class _HTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class _Response:
    def __init__(self, content=None, status_code=200, media_type=None):
        self.content = content
        self.status_code = status_code
        self.media_type = media_type


fastapi = types.ModuleType("fastapi")
fastapi.FastAPI = _FastAPI
fastapi.File = lambda *args, **kwargs: None
fastapi.Form = lambda *args, **kwargs: None
fastapi.HTTPException = _HTTPException
fastapi.UploadFile = type("UploadFile", (), {})
fastapi.WebSocket = type("WebSocket", (), {})
fastapi.WebSocketDisconnect = type("WebSocketDisconnect", (Exception,), {})
responses = types.ModuleType("fastapi.responses")
responses.JSONResponse = _Response
responses.PlainTextResponse = _Response
sys.modules.setdefault("fastapi", fastapi)
sys.modules.setdefault("fastapi.responses", responses)

module_path = Path(__file__).with_name("ai_stack_funasr_gateway.py")
spec = importlib.util.spec_from_file_location("ai_stack_funasr_gateway_tested", module_path)
gateway = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(gateway)


class GatewayContractTests(unittest.TestCase):
    def test_pipeline_model_overrides_conflicting_extensions(self):
        captured = {}
        original = gateway._pipeline_configuration

        def fake_configuration(preset, engine, diarization):
            captured.update(preset=preset, engine=engine, diarization=diarization)
            return {"id": preset, "warnings": [], "available": True}

        gateway._pipeline_configuration = fake_configuration
        try:
            pipeline = gateway._resolve_pipeline("pipeline:domain-zh", "general", "sensevoice", True)
        finally:
            gateway._pipeline_configuration = original

        self.assertEqual(captured, {"preset": "domain-zh", "engine": None, "diarization": True})
        self.assertEqual(pipeline["model"], "pipeline:domain-zh")
        self.assertEqual(len(pipeline["warnings"]), 2)

    def test_model_id_selects_engine_while_preserving_explicit_preset(self):
        captured = {}
        original = gateway._pipeline_configuration

        def fake_configuration(preset, engine, diarization):
            captured.update(preset=preset, engine=engine, diarization=diarization)
            return {"id": preset, "warnings": [], "available": True}

        gateway._pipeline_configuration = fake_configuration
        try:
            gateway._resolve_pipeline("iic/SenseVoiceSmall", "meeting", "paraformer", None)
        finally:
            gateway._pipeline_configuration = original

        self.assertEqual(captured["preset"], "meeting")
        self.assertEqual(captured["engine"], "sensevoice")

    def test_prompt_is_encoded_as_runtime_hotwords(self):
        self.assertEqual(
            json.loads(gateway._runtime_hotwords("通义千问，AI Stack\nFunASR")),
            {"通义千问": 20, "AI Stack": 20, "FunASR": 20},
        )

    def test_standard_verbose_and_subtitle_serializers(self):
        result = {
            "text": "你好",
            "duration": 1.25,
            "asrSegments": [{"start": 0.0, "end": 1.25, "text": "你好"}],
        }
        verbose = gateway._verbose_json(result, "zh", ["segment", "word"])
        self.assertEqual(verbose["task"], "transcribe")
        self.assertEqual(verbose["segments"][0]["end"], 1.25)
        self.assertEqual(verbose["words"], [])
        self.assertIn("00:00:00,000 --> 00:00:01,250", gateway._subtitle(result, "srt"))
        self.assertTrue(gateway._subtitle(result, "vtt").startswith("WEBVTT"))


if __name__ == "__main__":
    unittest.main()
