<!--
  @author Amuin
  @created 2026-06-25
  @description 自定义容器创建弹窗：流程化选择组件、编辑 Dockerfile、验证运行配置。
               Custom container creation modal: component selection, Dockerfile editing, and runtime validation.
-->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons-vue';
import {
  locale, t, composePlaceholder,
  containers, models,
  customName, customImage, customComponents, customMode, customRestartPolicy, customTab,
  composeYaml, composeValidating, composeValidationResult
} from '../../composables/useApp';
import {
  validateComposeYaml,
  createCustomContainerFromCompose,
  customComposeProfiles,
  loadCustomComposeProfiles,
  selectCustomComposeProfile,
  loadCustomProfileDockerfile, saveCustomProfileDockerfile, saveCustomComposeProfileMetadata
} from '../../composables/useServices';
import type { CustomComposeProfile, CustomProfileDockerfile } from '../../composables/useServices';

type ComponentKey = 'cuda' | 'pytorch' | 'python' | 'nodejs' | 'modelscope' | 'huggingface' | 'vllm' | 'tensorrt-llm' | 'asr' | 'tts';
type SelectedComponent = ComponentKey | string;

type ComponentSpec = {
  key: ComponentKey;
  title: string;
  titleZh: string;
  version: string;
  editable: boolean;
  group: 'base' | 'runtime' | 'service';
};

const baseImageOptions = [
  { label: 'PyTorch / nvcr.io/nvidia/pytorch:25.04-py3', value: 'nvcr.io/nvidia/pytorch:25.04-py3' },
  { label: 'vLLM / vllm-openai:latest', value: 'vllm/vllm-openai:latest' },
  { label: 'TensorRT-LLM / 1.2.0rc6', value: 'nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6' }
];

const defaultBaseImage = baseImageOptions[0].value;

const componentCatalog: ComponentSpec[] = [
  { key: 'cuda', title: 'CUDA / GPU runtime', titleZh: 'CUDA / GPU 运行时', version: 'host NVIDIA runtime', editable: false, group: 'base' },
  { key: 'python', title: 'Python', titleZh: 'Python', version: 'from base image', editable: false, group: 'base' },
  { key: 'pytorch', title: 'PyTorch', titleZh: 'PyTorch', version: 'NGC 25.04 image', editable: false, group: 'base' },
  { key: 'nodejs', title: 'Node.js tools', titleZh: 'Node.js 工具', version: '22.x', editable: true, group: 'base' },
  { key: 'huggingface', title: 'Hugging Face stack', titleZh: 'Hugging Face 组件', version: '4.52.0', editable: true, group: 'runtime' },
  { key: 'modelscope', title: 'ModelScope', titleZh: 'ModelScope', version: '1.27.0', editable: true, group: 'runtime' },
  { key: 'vllm', title: 'vLLM OpenAI server', titleZh: 'vLLM OpenAI 服务', version: 'latest', editable: true, group: 'runtime' },
  { key: 'tensorrt-llm', title: 'TensorRT-LLM', titleZh: 'TensorRT-LLM', version: '1.2.0rc6', editable: true, group: 'runtime' },
  { key: 'asr', title: 'ASR audio service', titleZh: 'ASR 音频服务', version: 'funasr 1.3.30', editable: true, group: 'service' },
  { key: 'tts', title: 'TTS helpers', titleZh: 'TTS 辅助组件', version: 'edge-tts 7.0.0', editable: true, group: 'service' }
];

const props = withDefaults(defineProps<{ open: boolean; mode?: 'create' | 'edit'; editingProfileId?: string }>(), {
  mode: 'create',
  editingProfileId: ''
});
const emit = defineEmits<{ close: [] }>();

const localOpen = computed({
  get: () => props.open,
  set: (val) => { if (!val) emit('close'); }
});

const isEditMode = computed(() => props.mode === 'edit');
const modalTitle = computed(() => isEditMode.value
  ? (locale.value === 'zh-CN' ? '编辑自定义运行时' : 'Edit custom runtime')
  : (locale.value === 'zh-CN' ? '新建自定义运行时' : 'Create custom runtime')
);

const componentVersions = reactive<Record<ComponentKey, string>>(componentCatalog.reduce((acc, item) => {
  acc[item.key] = item.version;
  return acc;
}, {} as Record<ComponentKey, string>));

const customComponentInput = ref('');
const knownComponentKeys = new Set<ComponentKey>(componentCatalog.map((item) => item.key));
const customPackageComponents = computed(() => customComponents.value.filter((item) => !knownComponentKeys.has(item as ComponentKey)));
const selectedSystemComponents = computed(() => componentCatalog.filter((item) => customComponents.value.includes(item.key)));
const hasExistingAudioRuntime = computed(() => containers.value.some((container) =>
  container.category === 'custom'
  && /funasr[-_ ]?gateway|custom_funasr_gateway/i.test([container.key, container.name, container.title].join(' '))
));

watch(() => props.open, (open) => {
  if (!open) return;
  void loadCustomComposeProfiles();
  if (isEditMode.value) {
    customTab.value = 'basics';
    const profile = currentComposeProfile.value;
    if (profile) {
      applyProfileSelection(profile.id);
      customName.value = composeProfileDisplayName(profile);
      void loadDockerfileForCurrentProfile(true);
    } else {
      if (!composeYaml.value.trim()) composeYaml.value = buildComposeFromCurrentState(defaultDockerfilePathForProfile());
      if (!runtimeImageTag.value.trim()) runtimeImageTag.value = customImage.value;
      if (!dockerfileContent.value.trim()) dockerfileContent.value = buildDockerfileFromComponents();
      composeValidationResult.value = null;
      readRuntimeConfigFromYaml();
    }
    return;
  }
  customTab.value = 'basics';
  const profile = currentComposeProfile.value;
  if (profile) applyProfileSelection(profile.id);
  else resetLocalDraft();
});

function componentTitle(item: ComponentSpec): string {
  return locale.value === 'zh-CN' ? item.titleZh : item.title;
}

function composeProfileDisplayName(profile: CustomComposeProfile): string {
  return locale.value === 'zh-CN' ? profile.title_zh : profile.title;
}

function dockerfileIdFromName(value: string): string {
  const id = value.trim()
    .toLowerCase()
    .replace(/^custom[_-]+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || 'custom-runtime';
}

function resetLocalDraft() {
  customName.value = '';
  customComponents.value = [];
  customImage.value = defaultBaseImage;
  runtimeImageTag.value = '';
  runtimePublicPort.value = null;
  runtimeModelAlias.value = '';
  runtimeSuitableModels.value = [];
  runtimeRestartPolicy.value = 'unless-stopped';
  customMode.value = 'resident';
  customRestartPolicy.value = 'unless-stopped';
  dockerfileMeta.value = null;
  dockerfileContent.value = '';
  customComponentInput.value = '';
  composeYaml.value = '';
  composeValidationResult.value = null;
}

function imageFromComposeYaml(yaml: string): string {
  const line = yaml.split('\n').find((item) => item.trim().startsWith('image:')) || '';
  const value = line.split('image:').slice(1).join('image:').split('#')[0].trim();
  let raw = value;
  if ((raw.startsWith('\"') && raw.endsWith('\"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1);
  const defaultStart = raw.indexOf(':-');
  return raw.charCodeAt(0) === 36 && raw.charCodeAt(1) === 123 && defaultStart >= 0 && raw.endsWith('}') ? raw.slice(defaultStart + 2, -1) : raw;
}

function baseImageFromComposeYaml(yaml: string): string {
  const argLine = yaml.split('\n').find((item) => /_BASE_IMAGE.*:-/.test(item));
  if (!argLine) return imageFromComposeYaml(yaml) || defaultBaseImage;
  const match = argLine.match(/_BASE_IMAGE.*:-([^}]+)}/);
  return match?.[1]?.trim() || defaultBaseImage;
}

function componentsForProfile(id: string): ComponentKey[] {
  if (id === 'funasr-gateway') return ['cuda', 'python', 'pytorch', 'modelscope', 'huggingface', 'asr'];
  if (id === 'vibevoice-hf') return ['cuda', 'python', 'pytorch', 'huggingface', 'asr'];
  if (id === 'qwen3-tts') return ['cuda', 'python', 'pytorch', 'huggingface', 'tts'];
  if (id === 'vllm-embedding' || id === 'vllm-reranker') return ['cuda', 'python', 'vllm', 'huggingface'];
  if (id === 'ocr-unlimited' || id === 'mineru' || id === 'locate-anything') return ['cuda', 'python', 'pytorch', 'huggingface'];
  return [];
}

function applyProfileSelection(id: string) {
  const profile = customComposeProfiles.value.find((item) => item.id === id);
  if (!profile) return;
  selectCustomComposeProfile(profile);
  customComponents.value = componentsForProfile(profile.id);
  customImage.value = baseImageFromComposeYaml(profile.yaml);
  runtimeSuitableModels.value = [...(profile.suitable_models ?? [])];
  runtimeImageTag.value = imageFromComposeYaml(profile.yaml);
  dockerfileMeta.value = null;
  dockerfileContent.value = '';
  composeValidationResult.value = null;
  readRuntimeConfigFromYaml();
}

const currentComposeProfile = computed(() => customComposeProfiles.value.find((profile) => {
  if (props.editingProfileId) return profile.id === props.editingProfileId;
  return profile.id === customName.value || profile.yaml.trim() === composeYaml.value.trim();
}));

function composeLineValue(yaml: string, key: string): string {
  const line = yaml.split('\n').find((item) => item.trim().startsWith(key + ':')) || '';
  return line.split(key + ':').slice(1).join(key + ':').split('#')[0].trim();
}

function stripComposeValue(value: string): string {
  let raw = value.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1);
  const defaultStart = raw.indexOf(':-');
  return raw.charCodeAt(0) === 36 && raw.charCodeAt(1) === 123 && defaultStart >= 0 && raw.endsWith('}') ? raw.slice(defaultStart + 2, -1) : raw;
}

function replaceEnvDefault(value: string, nextValue: string): string {
  const trimmed = value.trim();
  const quote = trimmed.startsWith('"') && trimmed.endsWith('"') ? '"' : trimmed.startsWith("'") && trimmed.endsWith("'") ? "'" : '';
  const unquoted = quote ? trimmed.slice(1, -1) : trimmed;
  const replaced = unquoted.replace(/(\$\{[^}:]+:-)[^}]+(\})/, (_match, start, end) => start + nextValue + end);
  return quote ? quote + replaced + quote : replaced;
}

function firstServiceName(yaml: string): string {
  const lines = yaml.split('\n');
  const servicesIndex = lines.findIndex((line) => line.trim() === 'services:');
  if (servicesIndex < 0) return '-';
  for (const line of lines.slice(servicesIndex + 1)) {
    const match = line.match(/^\s{2}([a-zA-Z0-9_.-]+):\s*$/);
    if (match) return match[1];
  }
  return '-';
}

function defaultDockerfilePathForProfile(): string {
  const id = currentComposeProfile.value?.id || dockerfileIdFromName(customName.value || 'custom-runtime');
  return 'deploy/dockerfiles/custom/' + id + '.Dockerfile';
}

function ensureComposeDockerfilePath(yaml: string, dockerfilePath: string): string {
  const lines = yaml.split('\n');
  const dockerfileIndex = lines.findIndex((line) => line.trim().startsWith('dockerfile:'));
  if (dockerfileIndex >= 0) {
    const indent = lines[dockerfileIndex].match(/^\s*/)?.[0] ?? '';
    lines[dockerfileIndex] = indent + 'dockerfile: ' + dockerfilePath;
    return lines.join('\n');
  }
  const buildIndex = lines.findIndex((line) => line.trim() === 'build:');
  if (buildIndex >= 0) {
    const indent = (lines[buildIndex].match(/^\s*/)?.[0] ?? '') + '  ';
    lines.splice(buildIndex + 1, 0, indent + 'dockerfile: ' + dockerfilePath);
    return lines.join('\n');
  }
  const imageIndex = lines.findIndex((line) => line.trim().startsWith('image:'));
  if (imageIndex < 0) return yaml;
  const indent = lines[imageIndex].match(/^\s*/)?.[0] ?? '';
  lines.splice(imageIndex + 1, 0,
    indent + 'build:',
    indent + '  context: ../../..',
    indent + '  dockerfile: ' + dockerfilePath
  );
  return lines.join('\n');
}

const runtimeImageTag = ref('');
const runtimePublicPort = ref<number | null>(null);
const runtimeModelAlias = ref('');
const runtimeSuitableModels = ref<string[]>([]);
const runtimeRestartPolicy = ref('unless-stopped');

watch(customMode, (mode) => {
  if (mode === 'once') {
    customRestartPolicy.value = 'no';
    runtimeRestartPolicy.value = 'no';
  }
});

watch(customRestartPolicy, (policy) => {
  runtimeRestartPolicy.value = policy;
});

const composeServiceName = computed(() => firstServiceName(composeYaml.value));
const composeContainerName = computed(() => stripComposeValue(composeLineValue(composeYaml.value, 'container_name')) || '-');
const composeDockerfilePath = computed(() => stripComposeValue(composeLineValue(composeYaml.value, 'dockerfile')) || dockerfileMeta.value?.dockerfile_path || defaultDockerfilePathForProfile());
const composeMounts = computed(() => composeYaml.value.split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('- ../../../'))
  .map((line) => {
    const raw = line.slice(2).trim().replace(/^["']|["']$/g, '');
    const [host, target, mode] = raw.split(':');
    const label = host.includes('/models') ? (locale.value === 'zh-CN' ? '模型目录' : 'Models')
      : host.includes('/cache') ? (locale.value === 'zh-CN' ? '缓存目录' : 'Cache')
      : (locale.value === 'zh-CN' ? '项目目录' : 'Project path');
    return { label, host: host.replace('../../../', 'AI Stack / '), target: target || '-', mode: mode || 'rw' };
  }));

function readRuntimeConfigFromYaml() {
  runtimeImageTag.value = stripComposeValue(composeLineValue(composeYaml.value, 'image')) || runtimeImageTag.value || customImage.value;
  const portMatch = composeYaml.value.match(/PUBLIC_PORT:-([0-9]+)/) || composeYaml.value.match(/:\$?\{?[^:}]*:?([0-9]{4,5})\}?:8000/);
  runtimePublicPort.value = portMatch ? Number(portMatch[1]) : runtimePublicPort.value;
  const modelAliasMatch = composeYaml.value.match(/MODEL_ALIAS:-([^}]+)/) || composeYaml.value.match(/OPENAI_MODEL:-([^}]+)/);
  runtimeModelAlias.value = modelAliasMatch?.[1] || runtimeModelAlias.value || '';
  const restart = composeYaml.value.match(/AI_STACK_RESTART_POLICY:-([^}]+)/);
  runtimeRestartPolicy.value = restart?.[1] || stripComposeValue(composeLineValue(composeYaml.value, 'restart')) || runtimeRestartPolicy.value || 'unless-stopped';
  customRestartPolicy.value = runtimeRestartPolicy.value;
}

watch(() => composeYaml.value, readRuntimeConfigFromYaml, { immediate: true });

const dockerfileMeta = ref<CustomProfileDockerfile | null>(null);
const dockerfileContent = ref('');
const dockerfileLoading = ref(false);
const dockerfileSaving = ref(false);
const profileSaving = ref(false);
const dockerfileProfileId = computed(() => currentComposeProfile.value?.id ?? '');
const dockerfileCanEdit = computed(() => Boolean(currentComposeProfile.value || dockerfileMeta.value || customName.value.trim()));

function isComponentSelected(key: ComponentKey): boolean {
  return customComponents.value.includes(key);
}

function addSystemComponent(key: ComponentKey) {
  if (customComponents.value.includes(key)) return;
  customComponents.value = [...customComponents.value, key];
}

function removeSystemComponent(key: ComponentKey) {
  customComponents.value = customComponents.value.filter((item) => item !== key);
}

function applyComponentPreset(keys: ComponentKey[]) {
  customComponents.value = [...keys, ...customPackageComponents.value];
  if (keys.includes('tensorrt-llm')) customImage.value = 'nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6';
  else if (keys.includes('vllm')) customImage.value = 'vllm/vllm-openai:latest';
  else customImage.value = defaultBaseImage;
}

function addCustomComponent() {
  const items = customComponentInput.value
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length) return;
  const next = new Set(customComponents.value);
  items.forEach((item) => next.add(item));
  customComponents.value = [...next];
  customComponentInput.value = '';
}

function removeCustomComponent(name: string) {
  customComponents.value = customComponents.value.filter((item) => item !== name);
}

function renameCustomComponent(oldName: string, nextName: string) {
  const trimmed = nextName.trim();
  if (!trimmed || trimmed === oldName) return;
  customComponents.value = customComponents.value.map((item) => item === oldName ? trimmed : item);
}

function componentPipRequirement(key: SelectedComponent): string[] {
  if (!knownComponentKeys.has(key as ComponentKey)) return [`"${key}"`];
  const version = componentVersions[key as ComponentKey].trim();
  if (key === 'huggingface') return [
    `"transformers>=${version || '4.52.0'}"`,
    '"huggingface-hub>=0.30.0"',
    '"accelerate>=0.34.0"',
    '"safetensors>=0.4.5"',
    '"sentencepiece>=0.2.0"'
  ];
  if (key === 'modelscope') return [`"modelscope>=${version || '1.27.0'}"`];
  if (key === 'vllm') return version === 'latest' ? ['"vllm"'] : [`"vllm>=${version}"`];
  if (key === 'asr') return [
    '"funasr==1.3.30"',
    '"openai-whisper>=20250625"',
    '"librosa>=0.10.2"',
    '"soundfile>=0.12.1"',
    '"scipy>=1.13.0"',
    '"pydub>=0.25.1"'
  ];
  if (key === 'tts') return ['"edge-tts>=7.0.0"', '"soundfile>=0.12.1"'];
  return [];
}

function buildDockerfileFromComponents(): string {
  const selected = new Set(customComponents.value as SelectedComponent[]);
  const baseImage = customImage.value.trim() || (selected.has('vllm') ? 'vllm/vllm-openai:latest' : selected.has('tensorrt-llm') ? 'nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6' : defaultBaseImage);
  const pipPackages = [...customComponents.value.flatMap((key) => componentPipRequirement(key))];
  const lines = [
    `ARG BASE_IMAGE=${baseImage}`,
    'FROM ${BASE_IMAGE}',
    '',
    'WORKDIR /app',
    'ENV PYTHONUNBUFFERED=1',
    'ENV PIP_NO_CACHE_DIR=1',
    'ENV HF_HOME=/cache/huggingface',
    'ENV MODELSCOPE_CACHE=/cache/modelscope',
    'ENV TRANSFORMERS_TRUST_REMOTE_CODE=1',
    ''
  ];

  if (selected.has('nodejs')) {
    const nodeVersion = componentVersions.nodejs.trim() || '22.x';
    lines.push(
      'RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \\',
      `    && curl -fsSL https://deb.nodesource.com/setup_${nodeVersion} | bash - \\`,
      '    && apt-get install -y --no-install-recommends nodejs \\',
      '    && rm -rf /var/lib/apt/lists/*',
      ''
    );
  }

  if (pipPackages.length) {
    lines.push('RUN python -m pip install --no-cache-dir \\');
    pipPackages.forEach((pkg, index) => {
      lines.push('    ' + pkg + (index === pipPackages.length - 1 ? '' : ' \\'));
    });
    lines.push('');
  }

  if (selected.has('asr')) lines.push('COPY deploy/templates/ai_stack_funasr_gateway.py /app/ai_stack_funasr_gateway.py', '');
  if (selected.has('tts')) lines.push('# COPY deploy/templates/your_tts_server.py /app/your_tts_server.py', '');

  lines.push(selected.has('asr') ? 'EXPOSE 8011' : 'EXPOSE 8000');
  if (selected.has('vllm')) lines.push('ENTRYPOINT ["python", "-m", "vllm.entrypoints.openai.api_server"]');
  else if (selected.has('asr')) lines.push('CMD ["python", "-m", "ai_stack_funasr_gateway", "--host", "0.0.0.0", "--port", "8011"]');
  else lines.push('CMD ["sleep", "infinity"]');
  lines.push('');
  return lines.join('\n');
}

function defaultLocalImageTag(): string {
  return 'local/ai-stack-' + dockerfileIdFromName(customName.value || 'custom-runtime') + ':latest';
}

function buildComposeFromCurrentState(dockerfilePath: string): string {
  const id = dockerfileIdFromName(customName.value || 'custom-runtime');
  const envPrefix = id.toUpperCase().replace(/-/g, '_');
  const serviceName = id + '-service';
  const containerName = 'custom_' + id.replace(/-/g, '_') + '_service';
  const publicPort = runtimePublicPort.value || 33090;
  const imageTag = runtimeImageTag.value.trim() || defaultLocalImageTag();
  return [
    'services:',
    '  ' + serviceName + ':',
    `    image: \${${envPrefix}_IMAGE:-${imageTag}}`,
    '    build:',
    '      context: ../../..',
    '      dockerfile: ' + dockerfilePath,
    '    container_name: ' + containerName,
    '    gpus: all',
    '    ipc: host',
    '    ports:',
    `      - "\${AI_STACK_BIND_ADDR:-127.0.0.1}:\${${envPrefix}_PUBLIC_PORT:-${publicPort}}:8000"`,
    '    restart: ${AI_STACK_RESTART_POLICY:-' + (runtimeRestartPolicy.value || 'unless-stopped') + '}',
    '    volumes:',
    '      - ${MODELS_ROOT:-../../../models}:/models:ro',
    '      - ../../../cache:/cache',
    '    environment:',
    '      - MODELS_ROOT=/models',
    '      - CACHE_ROOT=/cache',
    '    command:',
    '      - sleep',
    '      - infinity',
    ''
  ].join('\n');
}

function generateDockerfilePreview() {
  if (!customName.value.trim()) customName.value = dockerfileIdFromName(customComponents.value.join('-') || 'custom-runtime');
  if (!customComponents.value.length) {
    message.warning(locale.value === 'zh-CN' ? '请先选择至少一个组件' : 'Select at least one component');
    return;
  }
  const dockerfilePath = defaultDockerfilePathForProfile();
  dockerfileContent.value = buildDockerfileFromComponents();
  dockerfileMeta.value = {
    id: currentComposeProfile.value?.id || dockerfileIdFromName(customName.value),
    exists: false,
    compose_file: currentComposeProfile.value?.file || 'state/compose/' + dockerfileIdFromName(customName.value) + '/docker-compose.yml',
    dockerfile_path: dockerfilePath,
    image: defaultLocalImageTag(),
    content: dockerfileContent.value
  };
  if (composeYaml.value.trim()) composeYaml.value = ensureComposeDockerfilePath(composeYaml.value, dockerfilePath);
  else composeYaml.value = buildComposeFromCurrentState(dockerfilePath);
  runtimeImageTag.value = imageFromComposeYaml(composeYaml.value) || defaultLocalImageTag();
  composeValidationResult.value = null;
  customTab.value = 'dockerfile';
}

function applyRuntimeConfigToCompose(showSuccess = true) {
  const path = dockerfileMeta.value?.dockerfile_path || defaultDockerfilePathForProfile();
  let next = composeYaml.value.trim() ? ensureComposeDockerfilePath(composeYaml.value, path) : buildComposeFromCurrentState(path);
  if (runtimeImageTag.value.trim()) {
    next = next.replace(/^(\s*image:\s*)(.+)$/m, (_match, prefix, value) => prefix + replaceEnvDefault(value, runtimeImageTag.value.trim()));
  }
  if (runtimePublicPort.value) {
    next = next.replace(/(\$\{[A-Z0-9_]*PUBLIC_PORT:-)[0-9]+(\})/, (_match, start, end) => start + runtimePublicPort.value + end);
  }
  if (runtimeModelAlias.value.trim()) {
    if (/\$\{MODEL_ALIAS:-[^}]+\}/.test(next)) {
      next = next.replace(/(\$\{MODEL_ALIAS:-)[^}]+(\})/g, (_match, start, end) => start + runtimeModelAlias.value.trim() + end);
    }
    next = next.replace(/(\$\{OPENAI_MODEL:-)[^}]+(\})/g, (_match, start, end) => start + runtimeModelAlias.value.trim() + end);
  }
  if (runtimeRestartPolicy.value) {
    next = next.replace(/(\$\{AI_STACK_RESTART_POLICY:-)[^}]+(\})/, (_match, start, end) => start + runtimeRestartPolicy.value + end);
  }
  composeYaml.value = next;
  composeValidationResult.value = null;
  if (showSuccess) message.success(locale.value === 'zh-CN' ? '已应用到运行配置预览' : 'Applied to runtime preview');
}

async function loadDockerfileForCurrentProfile(force = false) {
  const profile = currentComposeProfile.value;
  if (!profile) {
    if (!isEditMode.value && !dockerfileMeta.value) dockerfileContent.value = '';
    return;
  }
  if (!force && dockerfileMeta.value?.id === profile.id && dockerfileContent.value.trim()) return;
  dockerfileLoading.value = true;
  try {
    const result = await loadCustomProfileDockerfile(profile);
    dockerfileMeta.value = result;
    dockerfileContent.value = result.content;
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    dockerfileLoading.value = false;
  }
}

watch([() => props.open, () => customTab.value, dockerfileProfileId, isEditMode], ([open, tab]) => {
  if (open && (tab === 'dockerfile' || isEditMode.value)) void loadDockerfileForCurrentProfile();
});

async function persistRuntimeProfileDraft(options: { regenerateDockerfile?: boolean; validate?: boolean; closeAfterSave?: boolean; successText?: string } = {}) {
  if (profileSaving.value || dockerfileSaving.value || composeValidating.value) return;
  profileSaving.value = true;
  try {
    const profile = currentComposeProfile.value;
    const path = dockerfileMeta.value?.dockerfile_path || defaultDockerfilePathForProfile();
    if (options.regenerateDockerfile) {
      if (!customName.value.trim()) customName.value = dockerfileIdFromName(customComponents.value.join('-') || 'custom-runtime');
      dockerfileContent.value = buildDockerfileFromComponents();
      dockerfileMeta.value = {
        id: profile?.id || dockerfileIdFromName(customName.value),
        exists: Boolean(profile),
        compose_file: profile?.file || 'state/compose/' + dockerfileIdFromName(customName.value) + '/docker-compose.yml',
        dockerfile_path: path,
        image: runtimeImageTag.value || defaultLocalImageTag(),
        content: dockerfileContent.value
      };
      composeYaml.value = composeYaml.value.trim()
        ? ensureComposeDockerfilePath(composeYaml.value, path)
        : buildComposeFromCurrentState(path);
    }
    if (dockerfileContent.value.trim()) await saveDockerfile(false);
    applyRuntimeConfigToCompose(false);
    if (options.validate) {
      await validateComposeYaml();
      if (!composeValidationResult.value?.valid) return;
    }
    if (profile) {
      const name = customName.value.trim() || composeProfileDisplayName(profile);
      await saveCustomComposeProfileMetadata(profile, {
        title: name,
        title_zh: name,
        suitable_models: runtimeSuitableModels.value,
        yaml: composeYaml.value
      });
      message.success(options.successText || (locale.value === 'zh-CN' ? '运行时配置已保存' : 'Runtime config saved'));
      if (options.closeAfterSave) emit('close');
      return;
    }
    if (options.closeAfterSave) {
      await createCustomContainerFromCompose({
        dockerfile_content: dockerfileContent.value.trim() || undefined,
        dockerfile_path: path,
        components: customComponents.value,
        suitable_models: runtimeSuitableModels.value
      });
    } else {
      message.success(options.successText || t('configSaved'));
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    profileSaving.value = false;
  }
}

async function saveBasicsPanel() {
  if (!isEditMode.value) {
    customTab.value = 'components';
    return;
  }
  await persistRuntimeProfileDraft({
    successText: locale.value === 'zh-CN' ? '基本信息已保存' : 'Basics saved'
  });
}

async function saveComponentsPanel() {
  if (!isEditMode.value) {
    generateDockerfilePreview();
    return;
  }
  if (!customComponents.value.length) {
    message.warning(locale.value === 'zh-CN' ? '请先选择至少一个组件' : 'Select at least one component');
    return;
  }
  await persistRuntimeProfileDraft({
    regenerateDockerfile: true,
    successText: locale.value === 'zh-CN' ? '组件配置已保存' : 'Component config saved'
  });
}

async function saveDockerfile(showSuccess = true) {
  const path = dockerfileMeta.value?.dockerfile_path || defaultDockerfilePathForProfile();
  if (!dockerfileContent.value.trim()) return;
  dockerfileSaving.value = true;
  try {
    const profile = currentComposeProfile.value;
    if (profile) {
      const result = await saveCustomProfileDockerfile(profile, dockerfileContent.value, path);
      const baseMeta = dockerfileMeta.value ?? {
        id: profile.id,
        exists: false,
        compose_file: profile.file,
        dockerfile_path: result.dockerfile_path,
        image: runtimeImageTag.value || customImage.value,
        content: dockerfileContent.value
      } satisfies CustomProfileDockerfile;
      dockerfileMeta.value = { ...baseMeta, exists: true, dockerfile_path: result.dockerfile_path, content: dockerfileContent.value };
      if (result.compose_yaml) composeYaml.value = result.compose_yaml;
    } else {
      dockerfileMeta.value = {
        id: dockerfileIdFromName(customName.value || 'custom-runtime'),
        exists: false,
        compose_file: 'state/compose/' + dockerfileIdFromName(customName.value || 'custom-runtime') + '/docker-compose.yml',
        dockerfile_path: path,
        image: runtimeImageTag.value || defaultLocalImageTag(),
        content: dockerfileContent.value
      };
      composeYaml.value = ensureComposeDockerfilePath(composeYaml.value || buildComposeFromCurrentState(path), path);
    }
    if (showSuccess) message.success(locale.value.startsWith('zh') ? 'Dockerfile 已应用' : 'Dockerfile applied');
  } catch (error) {
    if (showSuccess) message.error(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    dockerfileSaving.value = false;
  }
}


async function validateRuntimeCompose() {
  applyRuntimeConfigToCompose(false);
  await validateComposeYaml();
}

async function saveEditRuntimeConfig() {
  await persistRuntimeProfileDraft({ validate: true, closeAfterSave: true });
}

async function createRuntimeFromComposeConfig() {
  const path = dockerfileMeta.value?.dockerfile_path || defaultDockerfilePathForProfile();
  if (dockerfileContent.value.trim()) await saveDockerfile(false);
  applyRuntimeConfigToCompose(false);
  await validateComposeYaml();
  if (composeValidationResult.value?.valid) {
    await createCustomContainerFromCompose({
      dockerfile_content: dockerfileContent.value.trim() || undefined,
      dockerfile_path: path,
      components: customComponents.value,
      suitable_models: runtimeSuitableModels.value
    });
  }
}

</script>

<template>
  <a-modal
    v-model:open="localOpen"
    :title="modalTitle"
    :width="900"
    :footer="null"
    wrap-class-name="custom-runtime-modal-wrap"
    @cancel="emit('close')"
  >
    <a-tabs v-model:activeKey="customTab" type="card" class="custom-container-flow-tabs">
      <a-tab-pane key="basics" :tab="locale === 'zh-CN' ? '基本信息' : 'Basics'">
        <a-form layout="vertical" class="basics-form">
          <div class="basics-intro">
            <strong>{{ locale === 'zh-CN' ? '运行时身份与生命周期' : 'Runtime identity and lifecycle' }}</strong>
            <span>{{ locale === 'zh-CN' ? '设置运行时的发布方式，以及停止后的恢复行为。' : 'Control how this runtime is published and recovers after stopping.' }}</span>
          </div>
          <div class="basics-grid">
            <a-form-item :label="t('customName')">
              <a-input v-model:value="customName" :placeholder="locale === 'zh-CN' ? '例如 audio-funasr' : 'e.g. audio-funasr'" />
            </a-form-item>
            <a-form-item :label="locale === 'zh-CN' ? '端口' : 'Port'">
              <a-input-number v-model:value="runtimePublicPort" :min="1024" :max="65535" placeholder="33090" />
            </a-form-item>
            <a-form-item :label="locale === 'zh-CN' ? '状态管理' : 'Lifecycle mode'">
              <a-select v-model:value="customMode" :options="[
                { label: locale === 'zh-CN' ? '常驻' : 'Resident', value: 'resident' },
                { label: locale === 'zh-CN' ? '仅一次' : 'Run once', value: 'once' }
              ]" />
            </a-form-item>
            <a-form-item :label="locale === 'zh-CN' ? '重启策略' : 'Restart policy'">
              <a-select v-model:value="customRestartPolicy" :disabled="customMode === 'once'" :options="[
                { label: 'no', value: 'no' }, { label: 'unless-stopped', value: 'unless-stopped' },
                { label: 'always', value: 'always' }, { label: 'on-failure', value: 'on-failure' }
              ]" />
            </a-form-item>
            <a-form-item class="basics-model-coverage" :label="locale === 'zh-CN' ? '适用模型' : 'Suitable models'">
              <a-select
                v-model:value="runtimeSuitableModels"
                mode="tags"
                style="width: 100%"
                :options="models.map((model) => ({ label: model.display_name, value: model.id }))"
                :placeholder="locale === 'zh-CN' ? '选择模型或输入模型 ID；输入 * 表示通用' : 'Select or enter model IDs; use * for any model'"
              />
              <small>{{ locale === 'zh-CN' ? '模型发布页会优先依据此标记推荐该运行时。' : 'The publish page uses these tags when recommending this runtime.' }}</small>
            </a-form-item>
          </div>
          <div v-if="customMode === 'once'" class="basics-note">
            {{ locale === 'zh-CN' ? '仅一次模式不会自动重启，重启策略固定为 no。' : 'Run-once mode does not restart automatically, so restart policy is fixed to no.' }}
          </div>
          <div class="flow-actions">
            <a-button type="primary" :loading="profileSaving || dockerfileSaving" @click="saveBasicsPanel">
              {{ isEditMode
                ? (locale === 'zh-CN' ? '保存基本信息' : 'Save basics')
                : (locale === 'zh-CN' ? '下一步：组件编辑' : 'Next: components')
              }}
            </a-button>
          </div>
        </a-form>
      </a-tab-pane>

      <a-tab-pane key="components" :tab="locale === 'zh-CN' ? '组件编辑' : 'Components'">
        <div class="flow-panel">
          <div class="component-base-image">
            <a-form-item :label="locale === 'zh-CN' ? '基础镜像' : 'Base image'">
              <a-select v-model:value="customImage" :options="baseImageOptions" />
            </a-form-item>
          </div>

          <div class="preset-row">
            <span>{{ locale === 'zh-CN' ? '快捷选择' : 'Presets' }}</span>
            <a-button size="small" @click="applyComponentPreset(['cuda', 'python', 'pytorch', 'huggingface'])">
              {{ locale === 'zh-CN' ? '通用 PyTorch' : 'PyTorch preset' }}
            </a-button>
            <a-button v-if="!hasExistingAudioRuntime" size="small" @click="applyComponentPreset(['cuda', 'python', 'pytorch', 'modelscope', 'huggingface', 'asr'])">
              {{ locale === 'zh-CN' ? '音频 ASR' : 'Audio ASR' }}
            </a-button>
            <a-button size="small" @click="applyComponentPreset(['cuda', 'python', 'vllm', 'huggingface'])">
              vLLM
            </a-button>
          </div>

          <div class="component-columns">
            <section class="component-panel">
              <div class="component-panel-head">
                <strong>{{ locale === 'zh-CN' ? '可加载组件' : 'Available components' }}</strong>
              </div>
              <div class="component-list available">
                <div
                  v-for="item in componentCatalog"
                  :key="item.key"
                  :class="['component-row compact', { selected: isComponentSelected(item.key) }]"
                >
                  <span class="component-row-main">
                    <b>{{ componentTitle(item) }}</b>
                  </span>
                  <a-tooltip :title="isComponentSelected(item.key) ? (locale === 'zh-CN' ? '已加入' : 'Added') : (locale === 'zh-CN' ? '加入组件' : 'Add component')">
                    <a-button
                      class="component-add-button"
                      size="small"
                      shape="circle"
                      :disabled="isComponentSelected(item.key)"
                      :aria-label="locale === 'zh-CN' ? '加入组件' : 'Add component'"
                      @click="addSystemComponent(item.key)"
                    >
                      <template #icon><PlusOutlined /></template>
                    </a-button>
                  </a-tooltip>
                </div>
              </div>
              <div class="custom-component-row">
                <a-input
                  v-model:value="customComponentInput"
                  :placeholder="locale === 'zh-CN' ? '添加 pip 组件，例如 fastapi>=0.116.1' : 'Add pip package, e.g. fastapi>=0.116.1'"
                  @pressEnter="addCustomComponent"
                />
                <a-button @click="addCustomComponent">{{ locale === 'zh-CN' ? '添加' : 'Add' }}</a-button>
              </div>
            </section>

            <section class="component-panel selected-panel">
              <div class="component-panel-head">
                <strong>{{ locale === 'zh-CN' ? 'Dockerfile 加载组件' : 'Dockerfile components' }}</strong>
                <span>{{ customComponents.length }}</span>
              </div>
              <div class="component-list selected-list">
                <div v-if="!customComponents.length" class="component-empty">
                  {{ locale === 'zh-CN' ? '从左侧加入组件。' : 'Add components from the left.' }}
                </div>
                <div
                  v-for="item in selectedSystemComponents"
                  :key="item.key"
                  class="component-row selected"
                >
                  <span class="component-row-main">
                    <b>{{ componentTitle(item) }}</b>
                  </span>
                  <a-input
                    v-model:value="componentVersions[item.key]"
                    size="small"
                    :disabled="!item.editable"
                  />
                  <a-button size="small" type="text" danger :aria-label="locale === 'zh-CN' ? '移除组件' : 'Remove component'" @click="removeSystemComponent(item.key)">
                    <template #icon><DeleteOutlined /></template>
                  </a-button>
                </div>
                <div
                  v-for="item in customPackageComponents"
                  :key="item"
                  class="component-row selected custom"
                >
                  <span class="component-row-main">
                    <b>{{ locale === 'zh-CN' ? '自定义 pip 组件' : 'Custom pip package' }}</b>
                  </span>
                  <a-input
                    :value="item"
                    size="small"
                    @pressEnter="(event: any) => renameCustomComponent(item, event.target.value)"
                    @blur="(event: any) => renameCustomComponent(item, event.target.value)"
                  />
                  <a-button size="small" type="text" danger :aria-label="locale === 'zh-CN' ? '删除组件' : 'Remove component'" @click="removeCustomComponent(item)">
                    <template #icon><DeleteOutlined /></template>
                  </a-button>
                </div>
              </div>
            </section>
          </div>

          <div class="flow-actions preview-actions">
            <a-button type="primary" :loading="profileSaving || dockerfileSaving" @click="saveComponentsPanel">
              {{ isEditMode
                ? (locale === 'zh-CN' ? '保存组件配置' : 'Save components')
                : (locale === 'zh-CN' ? '生成 Dockerfile 预览' : 'Generate Dockerfile preview')
              }}
            </a-button>
          </div>
        </div>
      </a-tab-pane>

      <a-tab-pane key="dockerfile" tab="Dockerfile">
        <a-spin :spinning="dockerfileLoading" class="dockerfile-spin">
          <div class="dockerfile-editor-shell">
            <div v-if="!dockerfileCanEdit" class="dockerfile-empty-state">
              {{ locale === 'zh-CN' ? '先在组件清单中选择组件并生成 Dockerfile。' : 'Choose components first, then generate a Dockerfile.' }}
            </div>
            <template v-else>
              <div class="component-panel-head dockerfile-path-head">
                <strong>Dockerfile</strong>
                <span>{{ composeDockerfilePath }}</span>
                <a-button size="small" :disabled="dockerfileLoading || !currentComposeProfile" @click="loadDockerfileForCurrentProfile(true)">
                  {{ locale === 'zh-CN' ? '重载已有文件' : 'Reload' }}
                </a-button>
              </div>
              <a-textarea
                v-model:value="dockerfileContent"
                class="dockerfile-editor"
                :rows="22"
                placeholder="FROM nvcr.io/nvidia/pytorch:25.04-py3"
              />
              <div class="dockerfile-editor-actions">
                <a-button type="primary" :loading="dockerfileSaving" :disabled="dockerfileLoading || !dockerfileContent.trim()" @click="saveDockerfile()">
                  {{ locale === 'zh-CN' ? '应用 Dockerfile' : 'Apply Dockerfile' }}
                </a-button>
              </div>
            </template>
          </div>
        </a-spin>
      </a-tab-pane>

      <a-tab-pane key="compose" tab="Compose">
        <a-form layout="vertical" class="compose-editor-form">
          <div class="compose-tab-head">
            <span class="compose-tab-copy">
              <strong>Docker Compose YAML</strong>
              <span>{{ locale === 'zh-CN' ? '基本信息会同步到这里；也可以直接编辑最终配置。' : 'Basic settings sync here; you can also edit the final configuration directly.' }}</span>
            </span>
            <span class="compose-head-actions">
              <a-button @click="applyRuntimeConfigToCompose()">
                {{ locale === 'zh-CN' ? '应用到预览' : 'Apply to preview' }}
              </a-button>
              <a-button @click="validateRuntimeCompose" :loading="composeValidating">
                {{ locale === 'zh-CN' ? '验证配置' : 'Validate config' }}
              </a-button>
            </span>
          </div>
          <a-form-item>
            <a-textarea v-model:value="composeYaml" :rows="18" class="compose-editor" :placeholder="composePlaceholder" />
          </a-form-item>

          <div class="runtime-compose-actions">
            <a-button type="primary" @click="isEditMode ? saveEditRuntimeConfig() : createRuntimeFromComposeConfig()" :loading="composeValidating || dockerfileSaving || profileSaving">
              {{ isEditMode
                ? (locale === 'zh-CN' ? '验证并保存' : 'Validate and save')
                : (locale === 'zh-CN' ? '验证并应用' : 'Validate and apply')
              }}
            </a-button>
          </div>
          <div v-if="composeValidationResult" :class="['validation-result', composeValidationResult.valid ? 'success' : 'error']">
            {{ composeValidationResult.valid
              ? (locale === 'zh-CN' ? 'YAML 语法验证通过' : 'YAML syntax validated')
              : composeValidationResult.errors
            }}
          </div>
        </a-form>
      </a-tab-pane>
    </a-tabs>
  </a-modal>
</template>

<style scoped>
.custom-container-flow-tabs {
  height: min(640px, calc(100vh - 150px));
  min-height: 360px;
  display: flex;
  flex-direction: column;
}

.custom-container-flow-tabs :deep(.ant-tabs-nav) {
  flex: 0 0 auto;
  margin-bottom: 12px;
}

.custom-container-flow-tabs :deep(.ant-tabs-tab) {
  width: 112px;
  height: 38px;
  justify-content: center;
  padding: 0;
}

.custom-container-flow-tabs :deep(.ant-tabs-tab-btn) {
  width: 100%;
  text-align: center;
}

.custom-container-flow-tabs :deep(.ant-tabs-content-holder) {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  overflow: hidden;
}

.custom-container-flow-tabs :deep(.ant-tabs-content),
.custom-container-flow-tabs :deep(.ant-tabs-tabpane) {
  height: 100%;
  min-height: 0;
}

.flow-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.flow-grid.two {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  gap: 12px;
}

.flow-grid.two :deep(.ant-form-item) {
  margin-bottom: 0;
}

.preset-row {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  color: var(--text-muted, #687386);
  font-size: 12px;
}

.component-columns {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.16fr);
  gap: 12px;
  align-items: stretch;
}

.component-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--border, #d9dde7);
  border-radius: 8px;
  background: var(--surface, #fff);
}

.selected-panel {
  grid-template-rows: auto minmax(0, 1fr);
}

.component-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  padding: 7px 10px;
  background: var(--panel-muted, #f6f8fb);
  color: var(--text-muted, #687386);
  font-size: 12px;
}

.dockerfile-path-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  margin-bottom: 10px;
  border-radius: 6px;
}

.dockerfile-path-head span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dockerfile-path-head :deep(.ant-btn) {
  height: 24px;
  padding: 0 8px;
}

.component-panel-head strong {
  color: inherit;
  font-size: 12px;
  font-weight: 600;
}

.component-list {
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.component-row {
  display: grid;
  grid-template-columns: minmax(130px, 1fr) auto;
  gap: 8px;
  align-items: center;
  min-height: 34px;
  padding: 5px 10px;
  border-top: 1px solid var(--border, #d9dde7);
  transition: background 160ms ease;
}

.selected-list .component-row {
  grid-template-columns: minmax(130px, 1fr) minmax(130px, 170px) 32px;
}

.component-row.compact {
  grid-template-columns: minmax(130px, 1fr) 28px;
}

.component-add-button {
  width: 26px;
  min-width: 26px;
  height: 26px;
}

.component-row.selected {
  background: rgba(37, 99, 235, 0.05);
}

.component-row.custom {
  background: rgba(22, 163, 74, 0.06);
}

.component-row-main {
  min-width: 0;
}

.component-row-main b,
.dockerfile-editor-meta b,
.runtime-compose-readonly-grid b,
.runtime-compose-mount-grid b,
.compose-image-card b {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.component-row-main b {
  font-size: 13px;
  font-weight: 600;
}

.component-empty {
  padding: 28px 12px;
  color: var(--text-muted, #687386);
  text-align: center;
  font-size: 13px;
}

.custom-component-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--border, #d9dde7);
}

.flow-actions,
.dockerfile-editor-actions,
.runtime-compose-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

.preview-actions {
  justify-content: flex-end;
}

.dockerfile-spin,
.dockerfile-spin :deep(.ant-spin-container) {
  height: 100%;
  min-height: 0;
}

.dockerfile-editor-shell,
.runtime-compose-panel,
.compose-image-panel {
  border: 1px solid var(--border, #d9dde7);
  border-radius: 8px;
  padding: 14px;
  background: var(--surface, #fff);
}

.dockerfile-editor-shell {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.dockerfile-empty-state,
.runtime-compose-empty {
  padding: 24px;
  color: var(--text-muted, #687386);
  text-align: center;
}

.dockerfile-editor-meta,
.runtime-compose-readonly-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.dockerfile-editor-meta span,
.runtime-compose-readonly-grid span {
  min-width: 0;
  padding: 9px 10px;
  border-radius: 6px;
  background: var(--panel-muted, #f6f8fb);
  color: var(--text-muted, #687386);
  font-size: 12px;
}

.dockerfile-editor,
.compose-editor {
  flex: 1 1 auto;
  min-height: 0;
  height: auto !important;
  resize: none;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.55;
}

.dockerfile-editor-actions {
  flex: 0 0 auto;
  margin-top: 12px;
}

.compose-image-panel {
  margin-bottom: 12px;
}

.compose-image-head {
  margin-bottom: 8px;
}

.compose-image-card {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--panel-muted, #f6f8fb);
}

.compose-image-card span {
  color: var(--text-muted, #687386);
}

.runtime-compose-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}

.runtime-compose-grid label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--text-muted, #687386);
  font-size: 12px;
}

.runtime-compose-grid :deep(.ant-input-number),
.runtime-compose-grid :deep(.ant-select) {
  width: 100%;
}

.runtime-compose-mounts {
  margin-top: 12px;
}

.runtime-compose-mount-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 8px;
}

.runtime-compose-mount-grid span {
  min-width: 0;
  padding: 9px 10px;
  border-radius: 6px;
  background: var(--panel-muted, #f6f8fb);
}

.runtime-compose-mount-grid small {
  display: block;
  overflow: hidden;
  color: var(--text-muted, #687386);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compose-advanced-block {
  margin-top: 12px;
}

.compose-advanced-block summary {
  cursor: pointer;
  color: var(--text-muted, #687386);
  margin-bottom: 10px;
}

.runtime-compose-actions {
  flex: 0 0 auto;
  margin-top: 14px;
}

.validation-result {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 13px;
}

.validation-result.success {
  color: #166534;
  background: #dcfce7;
}

.validation-result.error {
  color: #991b1b;
  background: #fee2e2;
  white-space: pre-wrap;
}

.basics-form,
.compose-editor-form {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.compose-editor-form :deep(.ant-form-item) {
  flex: 1 1 auto;
  min-height: 0;
  margin-bottom: 0;
}

.compose-editor-form :deep(.ant-form-item-row) {
  flex: 1 1 auto;
  min-height: 0;
}

.compose-editor-form :deep(.ant-form-item-control),
.compose-editor-form :deep(.ant-form-item-control-input),
.compose-editor-form :deep(.ant-form-item-control-input-content) {
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
  display: flex;
}

.basics-intro,
.compose-tab-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-left: 3px solid var(--primary, #2563eb);
  border-radius: 6px;
  background: var(--panel-muted, #f6f8fb);
}

.compose-tab-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}

.compose-tab-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.compose-head-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.basics-intro span,
.compose-tab-copy > span {
  color: var(--text-muted, #687386);
  font-size: 12px;
}

.basics-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 14px;
}

.basics-grid :deep(.ant-input-number),
.basics-grid :deep(.ant-select) {
  width: 100%;
}

.basics-model-coverage {
  grid-column: 1 / -1;
}

.basics-model-coverage small {
  display: block;
  margin-top: 6px;
  color: var(--text-muted, #687386);
  font-size: 12px;
}

.basics-note {
  padding: 9px 12px;
  border-radius: 6px;
  color: var(--text-muted, #687386);
  background: var(--panel-muted, #f6f8fb);
  font-size: 12px;
}

.component-base-image {
  max-width: 520px;
}

.component-base-image :deep(.ant-form-item) {
  margin-bottom: 0;
}

.compose-editor-form .compose-editor {
  height: 100% !important;
}

.dockerfile-editor-shell .dockerfile-editor {
  height: 100% !important;
}

.compose-tab-head {
  flex: 0 0 auto;
}
@media (max-width: 760px) {
  .flow-grid.two,
  .basics-grid,
  .component-picker,
  .dockerfile-editor-meta,
  .runtime-compose-grid,
  .runtime-compose-readonly-grid,
  .runtime-compose-mount-grid {
    grid-template-columns: 1fr;
  }

  .basics-model-coverage {
    grid-column: auto;
  }

  .component-columns,
  .compose-tab-head {
    grid-template-columns: 1fr;
  }

  .compose-head-actions {
    justify-content: flex-start;
    flex-wrap: wrap;
  }

  .component-panel,
  .selected-panel {
    grid-template-rows: auto minmax(0, 1fr) auto;
  }

  .selected-list .component-row,
  .component-row.compact {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
