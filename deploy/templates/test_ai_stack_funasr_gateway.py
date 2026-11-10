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

    def test_sentence_info_becomes_real_asr_segments_with_milliseconds_to_seconds(self):
        result = [{
            "text": "第一句。第二句。",
            "sentence_info": [
                {"text": "第一句。", "start": 350, "end": 9950, "timestamp": [[350, 700], [9700, 9950]]},
                {"text": "第二句。", "start": 10020, "end": 12400, "timestamp": [[10020, 10400], [12100, 12400]]},
            ],
        }]

        segments = gateway._asr_segments(result, "zh", 12.5, require_sentence_timestamps=True)

        self.assertEqual(len(segments), 2)
        self.assertEqual((segments[0]["start"], segments[0]["end"]), (0.35, 9.95))
        self.assertEqual((segments[1]["start"], segments[1]["end"]), (10.02, 12.4))
        self.assertEqual(segments[0]["wordTimestamps"], [[0.35, 0.7], [9.7, 9.95]])
        self.assertEqual(gateway._asr_text(result, segments), "第一句。第二句。")
        self.assertEqual(
            gateway._asr_text(
                [{"text": "AI Stack验收。"}],
                [{"text": "ai stack 验收。"}],
            ),
            "AI Stack验收。",
        )
        self.assertEqual(
            gateway._asr_text(
                [{"text": "第一句。第二句。"}],
                [{"text": "第一句第。"}, {"text": "二句。"}],
            ),
            "第一句。第二句。",
        )

    def test_runtime_stamp_sents_are_preserved_as_sentences(self):
        result = [{
            "text": "第一句。第二句？",
            "stamp_sents": [
                {"text_seg": "第 一 句", "punc": "。", "start": 100, "end": 800, "ts_list": [[100, 300], [600, 800]]},
                {"text_seg": "第 二 句", "punc": "？", "start": 900, "end": 1800, "ts_list": [[900, 1200], [1500, 1800]]},
            ],
        }]

        segments = gateway._asr_segments(result, "zh", 2.0, require_sentence_timestamps=True)

        self.assertEqual([item["text"] for item in segments], ["第一句。", "第二句？"])
        self.assertEqual((segments[1]["start"], segments[1]["end"]), (0.9, 1.8))
        self.assertEqual(gateway._asr_text(result, segments), result[0]["text"])

    def test_paraformer_refuses_missing_or_incomplete_sentence_timestamps(self):
        with self.assertRaises(gateway.HTTPException) as missing:
            gateway._asr_segments([{"text": "不能伪造字幕"}], "zh", 10.0, require_sentence_timestamps=True)
        self.assertEqual(missing.exception.status_code, 502)

        result = [{"text": "第一句。第二句。", "sentence_info": [{"text": "第一句。", "start": 0, "end": 1000}]}]
        segments = gateway._asr_segments(result, "zh", 2.0, require_sentence_timestamps=True)
        with self.assertRaises(gateway.HTTPException) as incomplete:
            gateway._asr_text(result, segments)
        self.assertEqual(incomplete.exception.status_code, 502)

    def test_meeting_requests_sentence_timestamps_and_keeps_diarization_separate(self):
        captured = {}

        class FakeAsr:
            def generate(self, **kwargs):
                captured.update(kwargs)
                return [{
                    "text": "甲说。乙说。",
                    "sentence_info": [
                        {"text": "甲说。", "start": 100, "end": 900},
                        {"text": "乙说。", "start": 1100, "end": 1900},
                    ],
                }]

        class FakeDiarization:
            def __call__(self, _path, **_kwargs):
                return {"text": [[0.1, 0.9, 0], [1.1, 1.9, 1]]}

        originals = (
            gateway._duration_seconds,
            gateway._load_asr_model,
            gateway._load_diarization_model,
            gateway._diarization_state.copy(),
        )
        gateway._duration_seconds = lambda _path: 2.0
        gateway._load_asr_model = lambda _pipeline: FakeAsr()
        gateway._load_diarization_model = lambda: FakeDiarization()
        gateway._diarization_state["backend"] = "modelscope-pipeline"
        try:
            response = gateway._transcribe_path("meeting.wav", "zh", "2", {
                "id": "meeting", "engine": "paraformer", "execution": "python",
                "available": True, "diarization": True, "promptHotwords": False,
            })
        finally:
            gateway._duration_seconds, gateway._load_asr_model, gateway._load_diarization_model = originals[:3]
            gateway._diarization_state.clear()
            gateway._diarization_state.update(originals[3])

        self.assertIs(captured["sentence_timestamp"], True)
        self.assertEqual([item["text"] for item in response["asrSegments"]], ["甲说。", "乙说。"])
        self.assertEqual(len(response["diarizationSegments"]), 2)
        self.assertEqual(response["text"], "甲说。乙说。")

    def test_domain_hotwords_with_diarization_uses_runtime_sentences(self):
        captured = {}

        async def fake_runtime(_path, prompt=""):
            captured["prompt"] = prompt
            return [{
                "text": "通义实验室。AI Stack。",
                "stamp_sents": [
                    {"text_seg": "通 义 实 验 室", "punc": "。", "start": 200, "end": 1000},
                    {"text_seg": "AI Stack", "punc": "。", "start": 1200, "end": 2200},
                ],
            }]

        class FakeDiarization:
            def __call__(self, _path, **_kwargs):
                return {"text": [[0.2, 1.0, 0], [1.2, 2.2, 1]]}

        originals = (
            gateway._duration_seconds,
            gateway._runtime_sdk_transcribe,
            gateway._load_diarization_model,
            gateway._diarization_state.copy(),
        )
        gateway._duration_seconds = lambda _path: 2.5
        gateway._runtime_sdk_transcribe = fake_runtime
        gateway._load_diarization_model = lambda: FakeDiarization()
        gateway._diarization_state["backend"] = "modelscope-pipeline"
        try:
            response = gateway._transcribe_path("domain.wav", "zh", "2", {
                "id": "domain-zh", "engine": "paraformer", "execution": "runtime-sdk",
                "available": True, "diarization": True, "promptHotwords": True,
            }, "通义实验室,AI Stack")
        finally:
            gateway._duration_seconds, gateway._runtime_sdk_transcribe, gateway._load_diarization_model = originals[:3]
            gateway._diarization_state.clear()
            gateway._diarization_state.update(originals[3])

        self.assertEqual(captured["prompt"], "通义实验室,AI Stack")
        self.assertEqual([item["text"] for item in response["asrSegments"]], ["通义实验室。", "AI Stack。"])
        self.assertEqual(len(response["diarizationSegments"]), 2)

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
