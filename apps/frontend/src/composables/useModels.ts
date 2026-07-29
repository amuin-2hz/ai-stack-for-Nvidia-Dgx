/**
 * @author Amuin
 * @created 2026-06-25
 * @description 模型库（Models）页面本地状态、筛选逻辑与模型元数据辅助函数。
 *              Models page-local state, filter logic, and model metadata helpers.
 */
import { computed, ref } from 'vue';
import type { ModelRecord } from '../types';
import {
  locale, modelLibraryList, downloadTasks, selectDeployModel, view, formatBytes, modelFormatLabel,
  shortModelPath, statusText, compatibilityRows, runtimeHintColor, modelStatusHelp,
  modelAuditSummary, badgeColor
} from './useApp';

// ── 搜索 & 筛选 ──────────────────────────────────────────────────────────
/** 模型搜索关键词 */
export const librarySearch = ref('');
/** 当前选中的模型 ID */
export const activeLibraryModelId = ref('');
/** 当前选中的模型能力分类 */
export const libraryCategory = ref('all');

const activeDownloadStatuses = new Set(['queued', 'running', 'paused', 'canceling']);

const activeDownloadModelIds = computed(() => new Set(
  downloadTasks.value
    .filter((task) => activeDownloadStatuses.has(task.status))
    .flatMap((task) => [
      task.metadata?.alias,
      task.metadata?.model_id,
      String(task.metadata?.target_path ?? '').split('/').filter(Boolean).pop()
    ])
    .filter((value): value is string => Boolean(value))
));

/** 模型库主清单不展示未完成下载目录，也不展示仍有活动下载任务的目录。 */
export const visibleModelLibraryList = computed(() =>
  modelLibraryList.value.filter((model) =>
    model.status.download !== 'incomplete' && !activeDownloadModelIds.value.has(model.id)
  )
);

/** 经过关键词和分类筛选后的模型列表 */
export const filteredModelLibraryList = computed(() => {
  const term = librarySearch.value.trim().toLowerCase();
  const cat = libraryCategory.value;
  let list = visibleModelLibraryList.value;
  // 分类筛选
  if (cat !== 'all') {
    list = list.filter((model) => modelCapabilities(model).includes(cat));
  }
  // 关键词筛选
  if (term) {
    list = list.filter((model) => {
      return [model.id, model.display_name, model.local.path, model.local.format, modelFormatLabel(model.local.format)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  }
  return list;
});

/** 当前选中的模型对象 */
export const activeLibraryModel = computed(() =>
  visibleModelLibraryList.value.find((m) => m.id === activeLibraryModelId.value)
  ?? visibleModelLibraryList.value[0]
  ?? null
);

// ── 模型元数据辅助函数 ──────────────────────────────────────────────────

/** 推断模型来源（ModelScope / HuggingFace / Local） */
export function modelSourceLabel(model: ModelRecord): string {
  const text = [model.id, model.local.path].join(' ').toLowerCase();
  if (text.includes('modelscope')) return 'ModelScope';
  if (text.includes('huggingface') || text.includes('/hf/') || text.includes('hf-')) return 'HuggingFace';
  return 'Local';
}

/** 推断模型能力标签（Chat / Vision / ASR / TTS / Embedding） */
export function modelCapabilities(model: ModelRecord): string[] {
  const scanned = (model.capabilities ?? [])
    .map((capability) => capability.toLowerCase())
    .filter((capability) => capability && capability !== 'unknown');
  if (scanned.length) {
    const mapped = scanned.flatMap((capability) => {
      if (['chat', 'llm', 'text-generation'].includes(capability)) return ['Chat'];
      if (['vision', 'vlm', 'image'].includes(capability)) return ['Vision'];
      if (['asr', 'speech-to-text'].includes(capability)) return ['ASR'];
      if (['tts', 'text-to-speech'].includes(capability)) return ['TTS'];
      if (['embedding', 'embeddings'].includes(capability)) return ['Embedding'];
      if (['rerank', 'reranker'].includes(capability)) return ['Reranker'];
      if (capability === 'speaker-verification') return ['Speaker Verification'];
      if (capability === 'speaker-diarization') return ['Diarization'];
      return [];
    });
    if (mapped.length) return [...new Set(mapped)];
  }

  const text = [model.id, model.display_name, model.runtime.preferred, ...(model.runtime.supported ?? [])].join(' ').toLowerCase();
  const caps = new Set<string>();
  if (/(embed|bge|e5|gte)/.test(text)) caps.add('Embedding');
  if (/rerank/.test(text)) caps.add('Reranker');
  if (/(vision|vlm|ocr|document|image[-_ ]?to[-_ ]?text|qwen[-_ ]?vl|llava|internvl|minicpm[-_ ]?v|deepseek[-_ ]?vl|glm[-_ ]?4v)/.test(text)) caps.add('Vision');
  if (/(asr|whisper|funasr|speech)/.test(text)) caps.add('ASR');
  if (/(tts|cosyvoice|text-to-speech)/.test(text)) caps.add('TTS');
  if (/speaker[-_ ]?(verification|recognition)|campplus|eres2net/.test(text)) caps.add('Speaker Verification');
  if (/speaker[-_ ]?diari|diarization/.test(text)) caps.add('Diarization');
  if (!caps.size || /(chat|instruct|llm|qwen|llama|mistral|glm|deepseek)/.test(text)) caps.add('Chat');
  return [...caps];
}

/** 推断模型框架（Transformers / PyTorch / GGUF / TensorRT-LLM） */
export function modelArchitecture(model: ModelRecord): string {
  const format = model.local.format?.toLowerCase?.() || '';
  if (['hf_safetensors', 'hf_bin', 'hf_partial'].includes(format)) return 'Transformers';
  if (format === 'qwen3_tts' || model.runtime.preferred === 'qwen3-tts') return 'Qwen3-TTS';
  if (format.startsWith('audio') || model.runtime.preferred === 'pytorch') return 'PyTorch';
  if (format === 'gguf') return 'GGUF';
  if (format === 'trtllm_engine') return 'TensorRT-LLM';
  if (/^(transformers|pytorch|gguf|tensorrt-llm)$/i.test(model.local.architecture || '')) {
    return model.local.architecture || '-';
  }
  const text = [model.id, model.display_name, model.local.path, model.local.architecture].join('/').toLowerCase();
  if (/(cosyvoice|cosy-voice|funasr|fun-asr|sensevoice|sense-voice|whisper)/.test(text)) return 'PyTorch';
  if (/(qwen|llama|mistral|mixtral|gemma|deepseek|chatglm|glm|baichuan|\byi\b|yi-|phi|internvl|internlm|llava|minicpm|gpt-neox|gptj|gpt-j|gpt2|gpt-2|bert)/.test(text)) return 'Transformers';
  return '-';
}

/** 推断模型参数量级（如 7B, 13B） */
export function modelParameterScale(model: ModelRecord): string {
  const text = [model.id, model.display_name, model.local.path].join(' ');
  const matched = text.match(/(\d+(?:\.\d+)?)\s*([BbMmKk])/);
  return matched ? (matched[1] + matched[2].toUpperCase()) : '-';
}

/** 推断模型发布者 */
export function modelPublisher(model: ModelRecord): string {
  if (model.id.includes('/')) return model.id.split('/')[0] || modelSourceLabel(model);
  return modelSourceLabel(model);
}

function quantizationDisplay(spec: string): string {
  const normalized = spec.toUpperCase().replace('4BIT', '4-bit').replace('8BIT', '8-bit');
  if (/^(F16|F32|FP16|FP32|BF16)$/.test(spec.toUpperCase())) {
    return normalized;
  }
  return locale.value === 'zh-CN' ? `${normalized} 量化` : `${normalized} quantized`;
}

/** 推断模型量化规格（Q4_K_M / Q4_0 / INT8 / AWQ / BF16 等） */
export function modelQuantization(model: ModelRecord): string {
  if (model.local.quantization) return quantizationDisplay(model.local.quantization);
  const text = [model.id, model.display_name, model.local.path, model.local.format, modelFormatLabel(model.local.format)].join(' ');
  const matched = text.match(/\b(I?Q\d(?:_[A-Z0-9]+)*|TQ\d(?:_[A-Z0-9]+)*|Q\d(?:_[A-Z0-9]+)*|INT[48]|FP(?:16|32)|BF16|F(?:16|32)|4BIT|8BIT|NF4|GPTQ|AWQ)\b/i);
  return matched ? quantizationDisplay(matched[1]) : '-';
}

// ── 操作函数 ────────────────────────────────────────────────────────────

/** 从模型目录中选择模型并跳转到加载页 */
export function publishModelFromCatalog(model: ModelRecord) {
  selectDeployModel(model);
  view.value = 'load';
}
