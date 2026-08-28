/**
 * @author Amuin
 * @created 2026-06-25
 * @description Playground（模型测试）页面本地状态、推理调用与代码片段生成。
 *              Playground page-local state, inference calls, and code snippet generation.
 */
import { computed, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import type { DeploymentRecord, ModelRecord } from '../types';
import {
  locale, t, api, models, runningDeployments, backendOpenAiBaseUrl, backendOrigin, statusText
} from './useApp';

// ── 聊天消息类型 ──────────────────────────────────────────────────────────
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  timestamp: number;
};

export type PlaygroundMode =
  | 'chat'
  | 'vision'
  | 'embeddings'
  | 'reranker'
  | 'asr'
  | 'tts'
  | 'speaker-verification'
  | 'speaker-diarization';

export type PlaygroundModelItem = {
  model: ModelRecord;
  mode: PlaygroundMode;
  deployment?: DeploymentRecord;
};

/** 聊天消息历史 */
export const chatMessages = ref<ChatMessage[]>([]);

let _msgSeq = 0;
function nextMsgId() { return 'msg_' + (++_msgSeq) + '_' + Date.now(); }

function addMessage(role: ChatMessage['role'], content: string) {
  const item = { id: nextMsgId(), role, content, timestamp: Date.now() };
  chatMessages.value.push(item);
  return item;
}

function runtimeNotReadyMessage(deployment: DeploymentRecord): string {
  const model = deployment.openai_models?.[0] || deployment.model_id || deployment.runtime;
  const status = statusText(deployment.status || 'loading');
  return locale.value === 'zh-CN'
    ? `${model} 仍在加载，当前状态：${status}。请等状态变为运行中后再测试。`
    : `${model} is still loading. Current status: ${status}. Test again after it becomes Running.`;
}

function ensureDeploymentReady(
  deployment: DeploymentRecord,
  mode: PlaygroundMode
): boolean {
  if (deployment.status === 'running') return true;
  const errMsg = runtimeNotReadyMessage(deployment);
  if (mode === 'chat') {
    playgroundError.value = errMsg;
    addMessage('error', errMsg);
  } else if (mode === 'vision') {
    visionError.value = errMsg;
  } else if (mode === 'embeddings') {
    embeddingError.value = errMsg;
  } else if (mode === 'reranker') {
    rerankerError.value = errMsg;
  } else if (audioModes.has(mode)) {
    audioError.value = errMsg;
  }
  message.warning(errMsg);
  return false;
}

// ── 部署选择 ────────────────────────────────────────────────────────────
export const selectedPlaygroundDeploymentId = ref('');
export const selectedPlaygroundModelId = ref('');
export const playgroundSearch = ref('');

function deploymentCapabilityText(deployment?: DeploymentRecord | null): string {
  if (!deployment) return '';
  return [
    deployment.model_id,
    deployment.runtime,
    deployment.service_type,
    deployment.container_name,
    ...(deployment.openai_models ?? []),
    ...(deployment.warnings ?? [])
  ].filter(Boolean).join(' ').toLowerCase();
}

export function playgroundModeForModel(model?: ModelRecord | null): PlaygroundMode {
  const capabilities = new Set((model?.capabilities ?? []).map((item) => item.toLowerCase()));
  const text = [model?.id, model?.display_name, model?.runtime?.preferred, ...capabilities].filter(Boolean).join(' ').toLowerCase();
  if (capabilities.has('speaker-diarization') || /speaker[-_ ]?diari|diarization/.test(text)) return 'speaker-diarization';
  if (capabilities.has('speaker-verification') || /speaker[-_ ]?(verification|recognition)|campplus|eres2net/.test(text)) return 'speaker-verification';
  if (capabilities.has('tts') || /cosyvoice|text[-_ ]?to[-_ ]?speech|\btts\b/.test(text)) return 'tts';
  if (capabilities.has('asr') || /fun[-_ ]?asr|sensevoice|whisper|speech[-_ ]?to[-_ ]?text|\basr\b/.test(text)) return 'asr';
  if (capabilities.has('reranker') || /rerank/.test(text)) return 'reranker';
  if (capabilities.has('embeddings') || capabilities.has('embedding') || /embed|\bbge\b|\be5\b|\bgte\b/.test(text)) return 'embeddings';
  if (capabilities.has('vision') || /vision|vlm|ocr|document|qwen[-_ ]?vl|llava|internvl|minicpm[-_ ]?v/.test(text)) return 'vision';
  return 'chat';
}

export function playgroundModeForDeployment(deployment?: DeploymentRecord | null): PlaygroundMode {
  const text = deploymentCapabilityText(deployment);
  if (/(embed|embedding|bge|e5|gte|rerank)/.test(text)) return 'embeddings';
  if (/(vision|vlm|ocr|document|image[-_ ]?to[-_ ]?text|qwen[-_ ]?vl|llava|internvl|minicpm[-_ ]?v|deepseek[-_ ]?vl|glm[-_ ]?4v)/.test(text)) return 'vision';
  if (/(asr|whisper|funasr|speech)/.test(text)) return 'asr';
  if (/(tts|cosyvoice)/.test(text)) return 'tts';
  return 'chat';
}

function matchingDeployment(modelId: string): DeploymentRecord | undefined {
  return runningDeployments.value.find((item) =>
    item.model_id === modelId || item.openai_models?.includes(modelId)
  );
}

export const playgroundModelItems = computed<PlaygroundModelItem[]>(() =>
  models.value
    .filter((model) => model.status.download === 'ready')
    .map((model) => ({ model, mode: playgroundModeForModel(model), deployment: matchingDeployment(model.id) }))
);

const modeOrder: PlaygroundMode[] = [
  'chat', 'vision', 'embeddings', 'reranker', 'asr', 'tts',
  'speaker-verification', 'speaker-diarization'
];

export function playgroundModeLabel(mode: PlaygroundMode): string {
  const zh: Record<PlaygroundMode, string> = {
    chat: '对话', vision: '视觉 / OCR', embeddings: 'Embedding', reranker: 'Reranker',
    asr: '语音识别 ASR', tts: '语音合成 TTS',
    'speaker-verification': '声纹验证', 'speaker-diarization': '说话人分离'
  };
  const en: Record<PlaygroundMode, string> = {
    chat: 'Chat', vision: 'Vision / OCR', embeddings: 'Embedding', reranker: 'Reranker',
    asr: 'Speech Recognition', tts: 'Text to Speech',
    'speaker-verification': 'Speaker Verification', 'speaker-diarization': 'Speaker Diarization'
  };
  return (locale.value === 'zh-CN' ? zh : en)[mode];
}

export const playgroundModelGroups = computed(() => {
  const query = playgroundSearch.value.trim().toLowerCase();
  const items = query
    ? playgroundModelItems.value.filter((item) =>
        [item.model.id, item.model.display_name, playgroundModeLabel(item.mode)]
          .join(' ').toLowerCase().includes(query)
      )
    : playgroundModelItems.value;
  return modeOrder
    .map((mode) => ({ mode, label: playgroundModeLabel(mode), items: items.filter((item) => item.mode === mode) }))
    .filter((group) => group.items.length > 0);
});

export const selectedPlaygroundModel = computed(() => {
  const selected = models.value.find((item) => item.id === selectedPlaygroundModelId.value);
  if (selected) return selected;
  const deployment = runningDeployments.value.find((item) => item.deployment_id === selectedPlaygroundDeploymentId.value)
    ?? runningDeployments.value.find((item) => item.status === 'running');
  const deploymentModelId = deployment?.model_id || deployment?.openai_models?.[0];
  return models.value.find((item) => item.id === deploymentModelId)
    ?? playgroundModelItems.value[0]?.model;
});

/** 当前选中模型对应的 Playground 部署；音频模型由独立 Audio 服务承载。 */
export const selectedPlaygroundDeployment = computed(() => {
  const modelId = selectedPlaygroundModel.value?.id;
  return (modelId ? matchingDeployment(modelId) : undefined)
    ?? runningDeployments.value.find((item) => item.deployment_id === selectedPlaygroundDeploymentId.value);
});

export const playgroundTab = computed<PlaygroundMode>(() =>
  playgroundModeForModel(selectedPlaygroundModel.value)
);

const audioModes = new Set<PlaygroundMode>(['asr', 'tts', 'speaker-verification', 'speaker-diarization']);
export const selectedPlaygroundDeploymentReady = computed(() =>
  audioModes.has(playgroundTab.value) || selectedPlaygroundDeployment.value?.status === 'running'
);

export function selectPlaygroundModel(modelId: string) {
  selectedPlaygroundModelId.value = modelId;
  const deployment = matchingDeployment(modelId);
  selectedPlaygroundDeploymentId.value = deployment?.deployment_id ?? '';
}

watch(selectedPlaygroundDeploymentId, (deploymentId) => {
  if (!deploymentId) return;
  const deployment = runningDeployments.value.find((item) => item.deployment_id === deploymentId);
  const modelId = deployment?.model_id || deployment?.openai_models?.[0];
  if (modelId) selectedPlaygroundModelId.value = modelId;
});

// ── Chat 模式状态 ────────────────────────────────────────────────────────
export const playgroundPrompt = ref(
  locale.value === 'zh-CN'
    ? '用一句话介绍 AMUIN AI STACK。'
    : 'Introduce AMUIN AI STACK in one sentence.'
);

export const playgroundSessionStarted = ref(false);
export const playgroundTemperature = ref(0.7);
export const playgroundTopP = ref(0.9);
export const playgroundMaxTokens = ref(256);
export const playgroundStream = ref(true);
export const playgroundSystemPrompt = ref(
  locale.value === 'zh-CN'
    ? '你是本地 AI 工作站中的模型测试助手。'
    : 'You are the model testing assistant inside a local AI workstation.'
);

// ── Vision 模式状态 ──────────────────────────────────────────────────────
export const visionPrompt = ref(
  locale.value === 'zh-CN'
    ? '请描述这张图片中的关键内容。'
    : 'Describe the key contents of this image.'
);
export const visionImageUrl = ref('');

// ── Embeddings 模式状态 ──────────────────────────────────────────────────
export const embeddingInput = ref(
  locale.value === 'zh-CN' ? '本地 AI 工作站' : 'local AI workstation'
);

// ── Reranker 模式状态 ────────────────────────────────────────────────────
export const rerankerQuery = ref(
  locale.value === 'zh-CN' ? '哪一个模型适合中文语音识别？' : 'Which model is suitable for Chinese speech recognition?'
);
export const rerankerDocument = ref(
  locale.value === 'zh-CN' ? 'FunASR 是面向语音识别任务的模型。' : 'FunASR is designed for speech recognition tasks.'
);

// ── Audio 模式状态 ───────────────────────────────────────────────────────
export const audioFile = ref<File | null>(null);
export const speakerEnrollFile = ref<File | null>(null);
export const speakerTestFile = ref<File | null>(null);
export const speakerThreshold = ref(0.31);


export type AsrEngine = 'sensevoice' | 'paraformer';
export type AsrPreset = 'general' | 'accurate-zh' | 'domain-zh' | 'meeting';

const asrPresetDefaults: Record<AsrPreset, { engine: AsrEngine; diarization: boolean; labelZh: string; labelEn: string; detail: string }> = {
  general: { engine: 'sensevoice', diarization: false, labelZh: '普通转写', labelEn: 'General', detail: 'VAD + SenseVoice' },
  'accurate-zh': { engine: 'paraformer', diarization: false, labelZh: '高准确率中文', labelEn: 'Accurate Chinese', detail: 'VAD + Paraformer + N-gram-FST + PUNC' },
  'domain-zh': { engine: 'paraformer', diarization: false, labelZh: '固定领域', labelEn: 'Domain Chinese', detail: 'VAD + Paraformer + N-gram-FST + PUNC' },
  meeting: { engine: 'paraformer', diarization: true, labelZh: '会议转写', labelEn: 'Meeting', detail: 'ASR pipeline + speaker diarization' }
};

export const asrPreset = ref<AsrPreset>('general');
export const asrEngine = ref<AsrEngine>('sensevoice');
export const asrLanguage = ref('auto');
export const asrSpeakerCount = ref('auto');
export const asrDiarization = ref(false);
export const audioPipelineCatalog = ref<Array<Record<string, any>>>([]);

export const asrEngineOptions = computed(() => [
  { value: 'sensevoice', label: locale.value === 'zh-CN' ? 'SenseVoice · 快速通用' : 'SenseVoice · Fast general' },
  { value: 'paraformer', label: locale.value === 'zh-CN' ? 'Paraformer · 中文增强' : 'Paraformer · Enhanced Chinese' }
]);

export const asrPresetOptions = computed(() =>
  (Object.entries(asrPresetDefaults) as Array<[AsrPreset, typeof asrPresetDefaults[AsrPreset]]>).map(([value, item]) => {
    const runtime = audioPipelineCatalog.value.find((entry) => String(entry.id).replace(/^pipeline:/, '') === value);
    return {
      value,
      label: `${locale.value === 'zh-CN' ? item.labelZh : item.labelEn} · ${item.detail}`,
      disabled: runtime ? runtime.available === false : false
    };
  })
);

export const selectedAsrPipelineStatus = computed(() =>
  audioPipelineCatalog.value.find((entry) => String(entry.id).replace(/^pipeline:/, '') === asrPreset.value)
);

watch(asrPreset, (value) => {
  const preset = asrPresetDefaults[value];
  asrEngine.value = preset.engine;
  asrDiarization.value = preset.diarization;
}, { immediate: true });
// ── 异步状态 ─────────────────────────────────────────────────────────────
export const playgroundBusy = ref(false);
export const visionBusy = ref(false);
export const embeddingBusy = ref(false);
export const rerankerBusy = ref(false);
export const audioBusy = ref(false);

export const playgroundResponse = ref('');
export const visionResponse = ref('');
export const embeddingResponse = ref('');
export const rerankerResponse = ref('');
export const audioResponse = ref('');

export const playgroundError = ref('');
export const visionError = ref('');
export const embeddingError = ref('');
export const rerankerError = ref('');
export const audioError = ref('');

export const playgroundMetrics = ref<{ latencyMs?: number; tokens?: number; status?: string }>({});
export const visionMetrics = ref<{ latencyMs?: number; tokens?: number; status?: string }>({});
export const embeddingMetrics = ref<{ latencyMs?: number; dimensions?: number; status?: string }>({});
export const rerankerMetrics = ref<{ latencyMs?: number; score?: number; status?: string }>({});
export const audioMetrics = ref<{ latencyMs?: number; modelCount?: number; status?: string }>({});

// ── 计算属性 ─────────────────────────────────────────────────────────────

/** 是否有任意输出内容 */
export const playgroundHasOutput = computed(() => {
  return Boolean(
    playgroundResponse.value || visionResponse.value || embeddingResponse.value || rerankerResponse.value || audioResponse.value ||
    playgroundError.value || visionError.value || embeddingError.value || rerankerError.value || audioError.value
  );
});

export const activePlaygroundResponse = computed(() => {
  if (playgroundTab.value === 'vision') return visionResponse.value;
  if (playgroundTab.value === 'embeddings') return embeddingResponse.value;
  if (playgroundTab.value === 'reranker') return rerankerResponse.value;
  if (audioModes.has(playgroundTab.value)) return audioResponse.value;
  return playgroundResponse.value;
});

export const activePlaygroundError = computed(() => {
  if (playgroundTab.value === 'vision') return visionError.value;
  if (playgroundTab.value === 'embeddings') return embeddingError.value;
  if (playgroundTab.value === 'reranker') return rerankerError.value;
  if (audioModes.has(playgroundTab.value)) return audioError.value;
  return playgroundError.value;
});

/** 是否展示对话界面 */
export const playgroundConversationVisible = computed(() =>
  playgroundSessionStarted.value || playgroundHasOutput.value
);

/** 当前模式标题 */
export const playgroundModeTitle = computed(() => playgroundModeLabel(playgroundTab.value));

export const playgroundModeDescription = computed(() => {
  if (playgroundTab.value === 'vision') {
    return locale.value === 'zh-CN'
      ? '已识别为视觉模型，将使用图文消息测试。'
      : 'Detected as a vision model. Tests use image-plus-text messages.';
  }
  if (playgroundTab.value === 'embeddings') {
    return locale.value === 'zh-CN'
      ? '已识别为向量模型，将调用 embeddings 接口。'
      : 'Detected as an embedding model. Tests use the embeddings API.';
  }
  if (playgroundTab.value === 'reranker') {
    return locale.value === 'zh-CN'
      ? '已识别为排序模型，将调用 score 接口比较查询与文档。'
      : 'Detected as a reranker. Tests compare a query and document through the score API.';
  }
  if (playgroundTab.value === 'asr') {
    return locale.value === 'zh-CN'
      ? '上传音频文件后调用 FunASR Gateway 转写接口。'
      : 'Upload an audio file and call the FunASR Gateway transcription API.';
  }
  if (playgroundTab.value === 'speaker-verification') {
    return locale.value === 'zh-CN'
      ? '上传注册音频和待比对音频，使用 CAM++ 计算说话人相似度。'
      : 'Upload enrollment and test audio, then compare speaker similarity with CAM++.';
  }
  if (audioModes.has(playgroundTab.value)) {
    return locale.value === 'zh-CN'
      ? '模型已正确分类，但当前 Audio 运行时尚未提供这一能力的测试端点。'
      : 'The model is classified correctly, but the current Audio runtime does not expose this test endpoint yet.';
  }
  return locale.value === 'zh-CN'
    ? '已识别为聊天模型，将使用对话接口测试。'
    : 'Detected as a chat model. Tests use the chat completions API.';
});

/** 建议提示词列表 */
export const playgroundSuggestionList = computed(() => {
  if (playgroundTab.value === 'vision') {
    return locale.value === 'zh-CN'
      ? ['识别图片中的主体对象', '分析这张图的场景与动作', '提取适合做 caption 的一句话', '判断是否包含文字信息', '输出适合前端展示的结构化描述']
      : ['Identify the main object in the image', 'Analyze the scene and action', 'Generate a one-line caption', 'Detect whether text appears', 'Return a UI-friendly structured description'];
  }
  if (playgroundTab.value === 'embeddings') {
    return locale.value === 'zh-CN'
      ? ['比较两段文本语义是否接近', '生成适合检索的向量', '输出向量维度与前几项', '验证中文短句的向量质量', '测试中英混合文本的嵌入']
      : ['Compare semantic similarity between texts', 'Generate retrieval-ready vectors', 'Return dimensions and preview values', 'Validate Chinese sentence embeddings', 'Test mixed-language embeddings'];
  }
  if (playgroundTab.value === 'reranker') {
    return locale.value === 'zh-CN'
      ? ['比较查询和候选文档的相关性', '验证中文语义排序', '测试长短文本相关度', '检查 score 返回格式', '比较中英混合文本']
      : ['Compare query and document relevance', 'Validate Chinese semantic ranking', 'Test long and short text relevance', 'Inspect the score response', 'Compare mixed-language text'];
  }
  if (audioModes.has(playgroundTab.value)) {
    return locale.value === 'zh-CN'
      ? ['上传 WAV 或 MP3 音频', '验证音频服务可达性', '查看模型是否已挂载', '输出识别文本', '检查音频接口返回格式']
      : ['Upload WAV or MP3 audio', 'Validate audio service availability', 'Check whether the model is mounted', 'Return transcribed text', 'Inspect the audio response'];
  }
  return locale.value === 'zh-CN'
    ? ['用一句话介绍当前工作站', '判断这台机器适合部署什么模型', '生成一个 API 验证用例', '写一个模型压测提示词', '总结当前模型的适用场景']
    : ['Introduce the current workstation in one sentence', 'Suggest suitable models for this machine', 'Generate an API validation prompt', 'Write a load-test prompt', 'Summarize the model use cases'];
});

/** 辅助函数：获取 embedding 端点 URL */
export function embeddingEndpoint(deployment: DeploymentRecord): string {
  return publicBaseUrl(deployment) + (['vllm', 'trtllm'].includes(deployment.service_type) ? '/embeddings' : '/v1/embeddings');
}

// Need publicBaseUrl from useApp
import { publicBaseUrl } from './useApp';

// ── 代码片段生成（curl / Python SDK）───────────────────────────────────
const backendChatCompletionsUrl = computed(() => backendOpenAiBaseUrl.value + '/chat/completions');
const backendEmbeddingsUrl = computed(() => backendOpenAiBaseUrl.value + '/embeddings');
const backendScoreUrl = computed(() => backendOpenAiBaseUrl.value + '/score');

function selectedModelName(): string {
  return selectedPlaygroundModel.value?.id
    || selectedPlaygroundDeployment.value?.openai_models?.[0]
    || selectedPlaygroundDeployment.value?.model_id
    || 'model';
}

export const playgroundCurl = computed(() => {
  const model = selectedModelName();
  return `curl ${backendChatCompletionsUrl.value} -H "Content-Type: application/json" -d '{"model":"${model}","messages":[{"role":"user","content":"${playgroundPrompt.value}"}]}'`;
});

export const playgroundSdk = computed(() => {
  const model = selectedModelName();
  const baseUrl = backendOpenAiBaseUrl.value;
  return `from openai import OpenAI\nclient = OpenAI(base_url="${baseUrl}", api_key="EMPTY")\nprint(client.chat.completions.create(model="${model}", messages=[{"role":"user", "content":"${playgroundPrompt.value}"}]))`;
});

export const visionCurl = computed(() => {
  const model = selectedModelName();
  return `curl ${backendChatCompletionsUrl.value} -H "Content-Type: application/json" -d '{"model":"${model}","messages":[{"role":"user","content":[{"type":"text","text":"${visionPrompt.value}"},{"type":"image_url","image_url":{"url":"${visionImageUrl.value || 'https://example.com/image.png'}"}}]}]}'`;
});

export const visionSdk = computed(() => {
  const model = selectedModelName();
  const baseUrl = backendOpenAiBaseUrl.value;
  return `from openai import OpenAI\nclient = OpenAI(base_url="${baseUrl}", api_key="EMPTY")\nprint(client.chat.completions.create(model="${model}", messages=[{"role":"user", "content":[{"type":"text", "text":"${visionPrompt.value}"}, {"type":"image_url", "image_url":{"url":"${visionImageUrl.value || 'https://example.com/image.png'}"}}]}]))`;
});

export const embeddingCurl = computed(() => {
  const model = selectedModelName();
  return `curl ${backendEmbeddingsUrl.value} -H "Content-Type: application/json" -d '{"model":"${model}","input":"${embeddingInput.value}"}'`;
});

export const embeddingSdk = computed(() => {
  const model = selectedModelName();
  const baseUrl = backendOpenAiBaseUrl.value;
  return `from openai import OpenAI\nclient = OpenAI(base_url="${baseUrl}", api_key="EMPTY")\nprint(client.embeddings.create(model="${model}", input="${embeddingInput.value}"))`;
});

export const rerankerCurl = computed(() =>
  `curl ${backendScoreUrl.value} -H "Content-Type: application/json" -d '{"model":"${selectedModelName()}","text_1":"${rerankerQuery.value}","text_2":"${rerankerDocument.value}"}'`
);

export const audioCurl = computed(() =>
  `curl ${backendOrigin.value}/audio/transcriptions -F "model=${selectedModelName()}" -F "file=@audio.wav" -F "preset=${asrPreset.value}" -F "asrEngine=${asrEngine.value}" -F "language=${asrLanguage.value}" -F "speakerCount=${asrSpeakerCount.value}" -F "diarization=${asrDiarization.value}"`
);

export const speakerVerificationCurl = computed(() =>
  `curl ${backendOrigin.value}/audio/speaker-verifications -F "model=${selectedModelName()}" -F "threshold=${speakerThreshold.value}" -F "enroll=@speaker-a.wav" -F "test=@speaker-b.wav"`
);

// ── 辅助函数 ─────────────────────────────────────────────────────────────

export function clearPlaygroundChat() {
  chatMessages.value = [];
  playgroundResponse.value = '';
  playgroundError.value = '';
  playgroundMetrics.value = {};
  playgroundSessionStarted.value = false;
}

export function startPlaygroundSession() {
  playgroundSessionStarted.value = true;
  if (!selectedPlaygroundModelId.value) {
    const deployment = runningDeployments.value.find((item) => item.status === 'running');
    const modelId = deployment?.model_id || deployment?.openai_models?.[0] || playgroundModelItems.value[0]?.model.id;
    if (modelId) selectPlaygroundModel(modelId);
  }
}

export function startNewPlaygroundSession() {
  chatMessages.value = [];
  playgroundResponse.value = '';
  visionResponse.value = '';
  embeddingResponse.value = '';
  rerankerResponse.value = '';
  audioResponse.value = '';
  playgroundError.value = '';
  visionError.value = '';
  embeddingError.value = '';
  rerankerError.value = '';
  audioError.value = '';
  playgroundMetrics.value = {};
  visionMetrics.value = {};
  embeddingMetrics.value = {};
  rerankerMetrics.value = {};
  audioMetrics.value = {};
  startPlaygroundSession();
}

export function playgroundListSubtitle(item: PlaygroundModelItem): string {
  const status = item.deployment
    ? statusText(item.deployment.status)
    : audioModes.has(item.mode)
      ? (locale.value === 'zh-CN' ? '需 Audio 服务' : 'Audio service required')
      : (locale.value === 'zh-CN' ? '未发布' : 'Not published');
  return [playgroundModeLabel(item.mode), status].join(' · ');
}

export function clearPlaygroundCurrentMode() {
  if (playgroundTab.value === 'vision') {
    visionResponse.value = '';
    visionError.value = '';
    visionMetrics.value = {};
    return;
  }
  if (playgroundTab.value === 'embeddings') {
    embeddingResponse.value = '';
    embeddingError.value = '';
    embeddingMetrics.value = {};
    return;
  }
  if (playgroundTab.value === 'reranker') {
    rerankerResponse.value = '';
    rerankerError.value = '';
    rerankerMetrics.value = {};
    return;
  }
  if (audioModes.has(playgroundTab.value)) {
    audioResponse.value = '';
    audioError.value = '';
    audioMetrics.value = {};
    return;
  }
  clearPlaygroundChat();
}

// ── API 调用 ─────────────────────────────────────────────────────────────

async function streamOpenAiResponse(
  path: string,
  body: Record<string, unknown>,
  onDelta: (value: string) => void
): Promise<{ totalTokens?: number }> {
  const response = await fetch('/api' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...body,
      stream: true,
      stream_options: { include_usage: true }
    })
  });
  if (!response.ok) {
    const text = await response.text();
    try {
      const payload = JSON.parse(text);
      throw new Error(payload?.error?.message ?? payload?.detail ?? response.statusText);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(text || response.statusText || 'Stream request failed');
      throw error;
    }
  }
  if (!response.body) throw new Error('Streaming response body is unavailable.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalTokens: number | undefined;

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const payload = JSON.parse(data);
    const delta = payload?.choices?.[0]?.delta?.content
      ?? payload?.choices?.[0]?.text
      ?? '';
    if (delta) onDelta(String(delta));
    if (typeof payload?.usage?.total_tokens === 'number') totalTokens = payload.usage.total_tokens;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) consumeLine(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeLine(buffer);
  return { totalTokens };
}

/** 执行 Chat 推理 */
export async function runPlaygroundChat() {
  const deployment = selectedPlaygroundDeployment.value;
  if (!deployment) { message.warning(t('noRunningModels')); return; }
  if (!ensureDeploymentReady(deployment, 'chat')) return;
  const userPrompt = playgroundPrompt.value.trim();
  if (!userPrompt) { message.warning(locale.value === 'zh-CN' ? '请输入消息' : 'Please enter a message'); return; }
  startPlaygroundSession();
  addMessage('user', userPrompt);
  const model = deployment.openai_models?.[0] || deployment.model_id || deployment.runtime;
  const started = performance.now();
  let streamingMessage: ChatMessage | null = null;
  playgroundBusy.value = true; playgroundError.value = ''; playgroundResponse.value = ''; playgroundMetrics.value = {};
  try {
    const messagesPayload: Array<{ role: string; content: string }> = [];
    const sysPrompt = playgroundSystemPrompt.value.trim();
    if (sysPrompt) messagesPayload.push({ role: 'system', content: sysPrompt });
    // 发送最近 N 条历史消息以保持上下文
    const recentHistory = chatMessages.value.slice(-10);
    for (const msg of recentHistory) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messagesPayload.push({ role: msg.role, content: msg.content });
      }
    }
    // 确保最后一条是当前用户输入
    if (messagesPayload[messagesPayload.length - 1]?.content !== userPrompt) {
      messagesPayload.push({ role: 'user', content: userPrompt });
    }
    const requestBody = {
      model,
      messages: messagesPayload,
      temperature: playgroundTemperature.value,
      top_p: playgroundTopP.value,
      max_tokens: playgroundMaxTokens.value
    };
    if (playgroundStream.value) {
      streamingMessage = addMessage('assistant', '');
      const streamResult = await streamOpenAiResponse('/v1/chat/completions', requestBody, (delta) => {
        if (!streamingMessage) return;
        streamingMessage.content += delta;
        playgroundResponse.value = streamingMessage.content;
      });
      playgroundMetrics.value = {
        latencyMs: Math.round(performance.now() - started),
        tokens: streamResult.totalTokens,
        status: 'ok'
      };
    } else {
      const payload = await api<any>('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestBody, stream: false })
      });
      const reply = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? JSON.stringify(payload, null, 2);
      playgroundResponse.value = reply;
      addMessage('assistant', reply);
      playgroundMetrics.value = { latencyMs: Math.round(performance.now() - started), tokens: payload?.usage?.total_tokens, status: 'ok' };
    }
  } catch (error) {
    if (streamingMessage && !streamingMessage.content) {
      chatMessages.value = chatMessages.value.filter((item) => item.id !== streamingMessage?.id);
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    playgroundError.value = errMsg;
    addMessage('error', errMsg);
    playgroundMetrics.value = { latencyMs: Math.round(performance.now() - started), status: 'error' };
  } finally { playgroundBusy.value = false; }
}

/** 执行 Vision 推理 */
export async function runPlaygroundVision() {
  const deployment = selectedPlaygroundDeployment.value;
  if (!deployment) { message.warning(t('noRunningModels')); return; }
  if (!ensureDeploymentReady(deployment, 'vision')) return;
  const imageUrl = visionImageUrl.value.trim();
  if (!imageUrl) { message.warning(t('playgroundVisionImageRequired')); return; }
  startPlaygroundSession();
  const model = deployment.openai_models?.[0] || deployment.model_id || deployment.runtime;
  const started = performance.now();
  visionBusy.value = true; visionError.value = ''; visionResponse.value = ''; visionMetrics.value = {};
  try {
    const messagesPayload: any[] = [];
    if (playgroundSystemPrompt.value.trim()) messagesPayload.push({ role: 'system', content: playgroundSystemPrompt.value.trim() });
    messagesPayload.push({ role: 'user', content: [{ type: 'text', text: visionPrompt.value }, { type: 'image_url', image_url: { url: imageUrl } }] });
    const requestBody = {
      model,
      messages: messagesPayload,
      temperature: playgroundTemperature.value,
      top_p: playgroundTopP.value,
      max_tokens: playgroundMaxTokens.value
    };
    if (playgroundStream.value) {
      const streamResult = await streamOpenAiResponse('/v1/chat/completions', requestBody, (delta) => {
        visionResponse.value += delta;
      });
      visionMetrics.value = {
        latencyMs: Math.round(performance.now() - started),
        tokens: streamResult.totalTokens,
        status: 'ok'
      };
    } else {
      const payload = await api<any>('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestBody, stream: false })
      });
      visionResponse.value = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? JSON.stringify(payload, null, 2);
      visionMetrics.value = { latencyMs: Math.round(performance.now() - started), tokens: payload?.usage?.total_tokens, status: 'ok' };
    }
  } catch (error) {
    visionError.value = error instanceof Error ? error.message : String(error);
    visionMetrics.value = { latencyMs: Math.round(performance.now() - started), status: 'error' };
  } finally { visionBusy.value = false; }
}

/** 执行 Embedding 请求 */
export async function runPlaygroundEmbedding() {
  const deployment = selectedPlaygroundDeployment.value;
  if (!deployment) { message.warning(t('noRunningModels')); return; }
  if (!ensureDeploymentReady(deployment, 'embeddings')) return;
  startPlaygroundSession();
  const model = deployment.openai_models?.[0] || deployment.model_id || deployment.runtime;
  const started = performance.now();
  embeddingBusy.value = true; embeddingError.value = ''; embeddingResponse.value = ''; embeddingMetrics.value = {};
  try {
    const payload = await api<any>('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: embeddingInput.value })
    });
    const vector = payload?.data?.[0]?.embedding ?? [];
    embeddingMetrics.value = { latencyMs: Math.round(performance.now() - started), dimensions: Array.isArray(vector) ? vector.length : undefined, status: 'ok' };
    embeddingResponse.value = JSON.stringify({ dimensions: Array.isArray(vector) ? vector.length : null, preview: Array.isArray(vector) ? vector.slice(0, 8) : payload }, null, 2);
  } catch (error) {
    embeddingError.value = error instanceof Error ? error.message : String(error);
    embeddingMetrics.value = { latencyMs: Math.round(performance.now() - started), status: 'error' };
  } finally { embeddingBusy.value = false; }
}

/** 执行 Reranker score 请求 */
export async function runPlaygroundReranker() {
  const deployment = selectedPlaygroundDeployment.value;
  if (!deployment) { message.warning(t('noRunningModels')); return; }
  if (!ensureDeploymentReady(deployment, 'reranker')) return;
  if (!rerankerQuery.value.trim() || !rerankerDocument.value.trim()) {
    message.warning(locale.value === 'zh-CN' ? '请输入查询和候选文档' : 'Enter both a query and a candidate document');
    return;
  }
  startPlaygroundSession();
  const model = selectedModelName();
  const started = performance.now();
  rerankerBusy.value = true; rerankerError.value = ''; rerankerResponse.value = ''; rerankerMetrics.value = {};
  try {
    const payload = await api<any>('/v1/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        text_1: rerankerQuery.value,
        text_2: rerankerDocument.value
      })
    });
    const score = Number(payload?.data?.[0]?.score ?? payload?.score);
    rerankerMetrics.value = {
      latencyMs: Math.round(performance.now() - started),
      score: Number.isFinite(score) ? score : undefined,
      status: 'ok'
    };
    rerankerResponse.value = JSON.stringify(payload, null, 2);
  } catch (error) {
    rerankerError.value = error instanceof Error ? error.message : String(error);
    rerankerMetrics.value = { latencyMs: Math.round(performance.now() - started), status: 'error' };
  } finally { rerankerBusy.value = false; }
}

export function beforeAudioUpload(file: File): boolean {
  audioFile.value = file;
  audioError.value = '';
  return false;
}

export function beforeSpeakerEnrollUpload(file: File): boolean {
  speakerEnrollFile.value = file;
  audioError.value = '';
  return false;
}

export function beforeSpeakerTestUpload(file: File): boolean {
  speakerTestFile.value = file;
  audioError.value = '';
  return false;
}

/** 上传音频并执行 ASR 转写 */
export async function runAsrTranscription() {
  if (!audioFile.value) {
    message.warning(locale.value === 'zh-CN' ? '请先选择音频文件' : 'Choose an audio file first');
    return;
  }
  const model = selectedPlaygroundModel.value?.id;
  if (!model) {
    message.warning(locale.value === 'zh-CN' ? '请选择 ASR 模型' : 'Select an ASR model');
    return;
  }
  startPlaygroundSession();
  const started = performance.now();
  audioBusy.value = true; audioError.value = ''; audioResponse.value = ''; audioMetrics.value = {};
  try {
    const form = new FormData();
    form.append('model', model);
    form.append('file', audioFile.value, audioFile.value.name);
    form.append('preset', asrPreset.value);
    form.append('asrEngine', asrEngine.value);
    form.append('language', asrLanguage.value);
    form.append('speakerCount', asrSpeakerCount.value);
    form.append('diarization', String(asrDiarization.value));
    const payload = await api<any>('/audio/transcriptions', { method: 'POST', body: form });
    const transcript = String(payload?.text || '').trim();
    audioResponse.value = transcript ? `${transcript}\n\n${JSON.stringify(payload, null, 2)}` : JSON.stringify(payload, null, 2);
    audioMetrics.value = { latencyMs: Math.round(performance.now() - started), status: 'ok' };
  } catch (error) {
    audioError.value = error instanceof Error ? error.message : String(error);
    audioMetrics.value = { latencyMs: Math.round(performance.now() - started), status: 'error' };
  } finally { audioBusy.value = false; }
}

/** 比较两段音频是否来自同一说话人 */
export async function runSpeakerVerification() {
  if (!speakerEnrollFile.value || !speakerTestFile.value) {
    message.warning(locale.value === 'zh-CN' ? '请选择两段说话人音频' : 'Choose both speaker audio files');
    return;
  }
  const model = selectedPlaygroundModel.value?.id;
  if (!model) return;
  startPlaygroundSession();
  const started = performance.now();
  audioBusy.value = true; audioError.value = ''; audioResponse.value = ''; audioMetrics.value = {};
  try {
    const form = new FormData();
    form.append('model', model);
    form.append('threshold', String(speakerThreshold.value));
    form.append('enroll', speakerEnrollFile.value, speakerEnrollFile.value.name);
    form.append('test', speakerTestFile.value, speakerTestFile.value.name);
    const payload = await api<any>('/audio/speaker-verifications', { method: 'POST', body: form });
    const verdict = payload?.same_speaker
      ? (locale.value === 'zh-CN' ? '判断结果：同一说话人' : 'Result: same speaker')
      : (locale.value === 'zh-CN' ? '判断结果：不同说话人' : 'Result: different speakers');
    audioResponse.value = `${verdict}\n\n${JSON.stringify(payload, null, 2)}`;
    audioMetrics.value = { latencyMs: Math.round(performance.now() - started), status: 'ok' };
  } catch (error) {
    audioError.value = error instanceof Error ? error.message : String(error);
    audioMetrics.value = { latencyMs: Math.round(performance.now() - started), status: 'error' };
  } finally { audioBusy.value = false; }
}

/** 探测 Audio 模型列表 */
export async function loadAudioModels() {
  startPlaygroundSession();
  const started = performance.now();
  audioBusy.value = true; audioError.value = ''; audioResponse.value = ''; audioMetrics.value = {};
  try {
    const payload = await api<any>('/audio/models');
    const models = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    audioPipelineCatalog.value = models.filter((item: any) => item?.kind === 'asr-preset');
    audioResponse.value = JSON.stringify(payload, null, 2);
    audioMetrics.value = { latencyMs: Math.round(performance.now() - started), modelCount: models.length || undefined, status: 'ok' };
  } catch (error) {
    audioError.value = error instanceof Error ? error.message : String(error);
    audioMetrics.value = { latencyMs: Math.round(performance.now() - started), status: 'error' };
  } finally { audioBusy.value = false; }
}
