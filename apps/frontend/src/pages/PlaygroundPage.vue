<!--
  @author Amuin
  @created 2026-06-25
  @description Playground 模型测试页面：聊天列表、对话/视觉/嵌入/音频测试工作区与参数侧栏。
               Playground page: chat list, conversation/vision/embeddings/audio test workspace, and params sidebar.
-->
<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { CopyOutlined, FormOutlined, PlayCircleOutlined, UploadOutlined } from '@ant-design/icons-vue';
import {
  locale, t, copyText, rightPanelCollapsed
} from '../composables/useApp';
import {
  selectedPlaygroundDeploymentId, selectedPlaygroundModelId, selectedPlaygroundModel,
  selectedPlaygroundDeployment, selectedPlaygroundDeploymentReady,
  playgroundSearch, playgroundModelItems, playgroundModelGroups, selectPlaygroundModel,
  playgroundPrompt, playgroundTab, playgroundSessionStarted,
  playgroundTemperature, playgroundTopP, playgroundMaxTokens, playgroundStream, playgroundSystemPrompt,
  visionPrompt, visionImageUrl, embeddingInput, rerankerQuery, rerankerDocument, audioFile,
  speakerEnrollFile, speakerTestFile, speakerThreshold,
  playgroundBusy, visionBusy, embeddingBusy, rerankerBusy, audioBusy,
  playgroundResponse, activePlaygroundResponse, activePlaygroundError,
  playgroundError, visionError, embeddingError, rerankerError, audioError,
  playgroundMetrics, visionMetrics, embeddingMetrics, rerankerMetrics, audioMetrics,
  playgroundConversationVisible, playgroundModeTitle, playgroundModeDescription, playgroundSuggestionList,
  playgroundCurl, playgroundSdk, visionCurl, visionSdk, embeddingCurl, embeddingSdk, rerankerCurl, audioCurl, speakerVerificationCurl,
  startPlaygroundSession, startNewPlaygroundSession, playgroundListSubtitle, clearPlaygroundCurrentMode,
  runPlaygroundChat, runPlaygroundVision, runPlaygroundEmbedding, runPlaygroundReranker,
  beforeAudioUpload, runAsrTranscription,
  beforeSpeakerEnrollUpload, beforeSpeakerTestUpload, runSpeakerVerification, loadAudioModels,
  chatMessages,
} from '../composables/usePlayground';
import HeroBanner from '../components/shared/HeroBanner.vue';

/** 消息列表 DOM 引用，用于自动滚动到底部 */
const msgListRef = ref<HTMLElement | null>(null);

/** 新消息到达时自动滚动 */
watch(
  () => chatMessages.value.length,
  () => nextTick(() => msgListRef.value?.scrollTo({ top: msgListRef.value.scrollHeight, behavior: 'smooth' }))
);

function applySuggestion(value: string) {
  if (playgroundTab.value === 'vision') visionPrompt.value = value;
  else if (playgroundTab.value === 'embeddings') embeddingInput.value = value;
  else if (playgroundTab.value === 'reranker') rerankerQuery.value = value;
  else if (playgroundTab.value === 'chat') playgroundPrompt.value = value;
  startPlaygroundSession();
}
</script>

<template>
  <section :class="['prototype-page', 'chat-test-layout', 'playground-layout', rightPanelCollapsed ? 'right-panel-collapsed' : '']">
    <!-- 按能力分类的模型列表 -->
    <aside class="chatPanel prototype-chat-list">
      <div class="chatPanelHeader">
        <h1>{{ locale === 'zh-CN' ? '模型测试' : 'Model Tests' }}</h1>
        <div class="chatPanelTools">
          <button
            type="button"
            class="chatPanelIcon"
            :aria-label="locale === 'zh-CN' ? '新建会话' : 'New chat'"
            :title="locale === 'zh-CN' ? '新建会话' : 'New chat'"
            @click="startNewPlaygroundSession"
          >
            <FormOutlined />
          </button>
        </div>
      </div>
      <div class="playgroundSearchWrap">
        <a-input v-model:value="playgroundSearch" allow-clear :placeholder="locale === 'zh-CN' ? '搜索模型或能力...' : 'Search models or capabilities...'" size="small" />
      </div>
      <div class="chatList playgroundModelList">
        <section v-for="group in playgroundModelGroups" :key="group.mode" class="playgroundModelGroup">
          <div class="playgroundModelGroupHead">
            <span>{{ group.label }}</span>
            <b>{{ group.items.length }}</b>
          </div>
          <button
            v-for="item in group.items" :key="item.model.id"
            type="button"
            :class="['chatItem', selectedPlaygroundModel?.id === item.model.id ? 'isSelected' : '', item.deployment?.status === 'running' ? 'isRunning' : '']"
            @click="selectPlaygroundModel(item.model.id)"
          >
            <span class="chatItemTitle">{{ item.model.display_name }}</span>
            <span class="chatItemMeta">{{ playgroundListSubtitle(item) }}</span>
          </button>
        </section>
        <div v-if="!playgroundModelItems.length" class="playgroundModelEmpty">
          {{ locale === 'zh-CN' ? '没有已下载完成的模型' : 'No downloaded models are ready' }}
        </div>
      </div>
    </aside>

    <HeroBanner v-if="!playgroundConversationVisible" :title="t('playground')" :eyebrow="t('studioName')" class="playgroundBanner" />

    <!-- 主工作区 -->
    <section class="playground-main-panel">
      <!-- 欢迎页 -->
      <div v-if="!playgroundConversationVisible" class="playground-welcome-panel">
        <div class="playground-welcome-symbol">✦</div>
        <h2>{{ t('playgroundWelcome') }}</h2>
        <p>{{ locale === 'zh-CN' ? '这里先显示欢迎页。点击"新建对话"或发送第一条消息后，中间区域再进入正式会话界面。' : 'This starts as a welcome page. After creating a chat or sending the first message, the center switches into the conversation workspace.' }}</p>
        <button class="playground-welcome-button" type="button" @click="startPlaygroundSession()">{{ locale === 'zh-CN' ? '新建对话' : 'New Chat' }}</button>
        <div class="playgroundSuggestionList">
          <button v-for="item in playgroundSuggestionList" :key="item" type="button" class="playgroundSuggestionItem" @click="applySuggestion(item)">{{ item }}</button>
        </div>
      </div>

      <!-- 对话界面 -->
      <div v-else class="playground-conversation-shell">
        <!-- 消息气泡列表 -->
        <div class="playground-message-list" ref="msgListRef">
          <div v-if="!chatMessages.length && !activePlaygroundResponse && !activePlaygroundError" class="playground-empty-chat">
            <span>{{ locale === 'zh-CN' ? '填写测试输入并运行模型' : 'Provide test input and run the model' }}</span>
          </div>
          <div v-for="msg in (playgroundTab === 'chat' ? chatMessages : [])" :key="msg.id" :class="['playground-chat-bubble', msg.role]">
            <div class="playground-bubble-avatar">{{ msg.role === 'user' ? '👤' : msg.role === 'error' ? '⚠️' : '🤖' }}</div>
            <div class="playground-bubble-body">
              <div class="playground-bubble-role">{{ msg.role === 'user' ? (locale === 'zh-CN' ? '你' : 'You') : msg.role === 'error' ? 'Error' : (selectedPlaygroundDeployment?.openai_models?.[0] || selectedPlaygroundDeployment?.runtime || 'Model') }}</div>
              <div class="playground-bubble-content">
                <div v-if="msg.role === 'user' && playgroundTab === 'vision' && visionImageUrl && msg === chatMessages[chatMessages.length-1]" class="playground-image-preview"><img :src="visionImageUrl" :alt="t('playgroundVision')" /></div>
                <pre v-if="msg.role === 'user' || msg.role === 'error'">{{ msg.content }}</pre>
                <pre v-else>{{ msg.content }}</pre>
              </div>
              <div class="playground-bubble-time">{{ new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</div>
            </div>
          </div>
          <div v-if="playgroundTab !== 'chat' && (activePlaygroundResponse || activePlaygroundError)" :class="['playground-chat-bubble', activePlaygroundError ? 'error' : 'assistant']">
            <div class="playground-bubble-avatar">{{ activePlaygroundError ? '!' : 'AI' }}</div>
            <div class="playground-bubble-body">
              <div class="playground-bubble-role">{{ activePlaygroundError ? 'Error' : playgroundModeTitle }}</div>
              <div class="playground-bubble-content"><pre>{{ activePlaygroundError || activePlaygroundResponse }}</pre></div>
            </div>
          </div>
          <!-- 加载指示器 -->
          <div v-if="playgroundBusy || visionBusy || embeddingBusy || rerankerBusy || audioBusy" class="playground-chat-bubble assistant">
            <div class="playground-bubble-avatar">🤖</div>
            <div class="playground-bubble-body">
              <div class="playground-bubble-content"><span class="playground-typing-indicator"><i></i><i></i><i></i></span></div>
            </div>
          </div>
        </div>

        <!-- 指标栏 -->
        <div v-if="(playgroundMetrics.latencyMs || playgroundMetrics.status) || (visionMetrics.latencyMs || visionMetrics.status) || (embeddingMetrics.latencyMs || embeddingMetrics.status) || (rerankerMetrics.latencyMs || rerankerMetrics.status) || (audioMetrics.latencyMs || audioMetrics.status)" class="playground-metrics-bar">
          <template v-if="playgroundTab === 'vision'">
            <a-tag color="blue">{{ visionMetrics.latencyMs ?? 0 }} ms</a-tag>
            <a-tag v-if="visionMetrics.tokens" color="green">{{ visionMetrics.tokens }} tokens</a-tag>
            <a-tag :color="visionError ? 'red' : 'green'">{{ visionMetrics.status || 'ok' }}</a-tag>
          </template>
          <template v-else-if="playgroundTab === 'embeddings'">
            <a-tag color="blue">{{ embeddingMetrics.latencyMs ?? 0 }} ms</a-tag>
            <a-tag v-if="embeddingMetrics.dimensions" color="green">{{ embeddingMetrics.dimensions }} dims</a-tag>
            <a-tag :color="embeddingError ? 'red' : 'green'">{{ embeddingMetrics.status || 'ok' }}</a-tag>
          </template>
          <template v-else-if="playgroundTab === 'reranker'">
            <a-tag color="blue">{{ rerankerMetrics.latencyMs ?? 0 }} ms</a-tag>
            <a-tag v-if="rerankerMetrics.score !== undefined" color="green">score {{ rerankerMetrics.score }}</a-tag>
            <a-tag :color="rerankerError ? 'red' : 'green'">{{ rerankerMetrics.status || 'ok' }}</a-tag>
          </template>
          <template v-else-if="['asr', 'tts', 'speaker-verification', 'speaker-diarization'].includes(playgroundTab)">
            <a-tag color="blue">{{ audioMetrics.latencyMs ?? 0 }} ms</a-tag>
            <a-tag v-if="audioMetrics.modelCount" color="green">{{ audioMetrics.modelCount }} models</a-tag>
            <a-tag :color="audioError ? 'red' : 'green'">{{ audioMetrics.status || 'ok' }}</a-tag>
          </template>
          <template v-else>
            <a-tag color="blue">{{ playgroundMetrics.latencyMs ?? 0 }} ms</a-tag>
            <a-tag v-if="playgroundMetrics.tokens" color="green">{{ playgroundMetrics.tokens }} tokens</a-tag>
            <a-tag :color="playgroundError ? 'red' : 'green'">{{ playgroundMetrics.status || 'ok' }}</a-tag>
          </template>
        </div>

        <!-- 消息输入区 -->
        <a-card class="glass-card playground-composer-card" :bordered="false">
          <div class="playgroundComposerHead">
            <span>{{ locale === 'zh-CN' ? '测试输入' : 'Test Input' }}</span>
            <b>{{ selectedPlaygroundModel?.display_name || t('noRunningModels') }}</b>
          </div>
          <template v-if="playgroundTab === 'chat'">
            <a-textarea v-model:value="playgroundPrompt" :rows="5" class="playgroundComposerInput" :placeholder="locale === 'zh-CN' ? '向模型发送一条测试消息...' : 'Send a test message to the model...'" />
            <a-space wrap class="playground-action-row">
              <a-button type="primary" :loading="playgroundBusy" :disabled="!selectedPlaygroundDeploymentReady" @click="runPlaygroundChat"><template #icon><PlayCircleOutlined /></template>{{ t('playgroundSendTest') }}</a-button>
              <a-button @click="clearPlaygroundCurrentMode">{{ t('playgroundClear') }}</a-button>
              <a-button @click="copyText(playgroundCurl)"><template #icon><CopyOutlined /></template>curl</a-button>
              <a-button @click="copyText(playgroundSdk)"><template #icon><CopyOutlined /></template>OpenAI SDK</a-button>
            </a-space>
          </template>
          <template v-else-if="playgroundTab === 'vision'">
            <a-input v-model:value="visionImageUrl" :placeholder="t('playgroundImageUrlPlaceholder')" style="margin-bottom:10px" />
            <a-textarea v-model:value="visionPrompt" :rows="4" class="playgroundComposerInput" :placeholder="t('playgroundVisionPrompt')" />
            <a-space wrap class="playground-action-row">
              <a-button type="primary" :loading="visionBusy" :disabled="!selectedPlaygroundDeploymentReady" @click="runPlaygroundVision"><template #icon><PlayCircleOutlined /></template>{{ t('playgroundSendTest') }}</a-button>
              <a-button @click="clearPlaygroundCurrentMode">{{ t('playgroundClear') }}</a-button>
              <a-button @click="copyText(visionCurl)"><template #icon><CopyOutlined /></template>curl</a-button>
              <a-button @click="copyText(visionSdk)"><template #icon><CopyOutlined /></template>OpenAI SDK</a-button>
            </a-space>
          </template>
          <template v-else-if="playgroundTab === 'embeddings'">
            <a-textarea v-model:value="embeddingInput" :rows="4" class="playgroundComposerInput" :placeholder="t('playgroundInputText')" />
            <a-space wrap class="playground-action-row">
              <a-button type="primary" :loading="embeddingBusy" :disabled="!selectedPlaygroundDeploymentReady" @click="runPlaygroundEmbedding"><template #icon><PlayCircleOutlined /></template>{{ t('playgroundCreateEmbedding') }}</a-button>
              <a-button @click="clearPlaygroundCurrentMode">{{ t('playgroundClear') }}</a-button>
              <a-button @click="copyText(embeddingCurl)"><template #icon><CopyOutlined /></template>curl</a-button>
              <a-button @click="copyText(embeddingSdk)"><template #icon><CopyOutlined /></template>OpenAI SDK</a-button>
            </a-space>
          </template>
          <template v-else-if="playgroundTab === 'reranker'">
            <a-input v-model:value="rerankerQuery" :placeholder="locale === 'zh-CN' ? '查询文本' : 'Query text'" />
            <a-textarea v-model:value="rerankerDocument" :rows="4" class="playgroundComposerInput" :placeholder="locale === 'zh-CN' ? '候选文档' : 'Candidate document'" />
            <a-space wrap class="playground-action-row">
              <a-button type="primary" :loading="rerankerBusy" :disabled="!selectedPlaygroundDeploymentReady" @click="runPlaygroundReranker"><template #icon><PlayCircleOutlined /></template>{{ locale === 'zh-CN' ? '计算相关度' : 'Calculate Score' }}</a-button>
              <a-button @click="clearPlaygroundCurrentMode">{{ t('playgroundClear') }}</a-button>
              <a-button @click="copyText(rerankerCurl)"><template #icon><CopyOutlined /></template>curl</a-button>
            </a-space>
          </template>
          <template v-else-if="playgroundTab === 'asr'">
            <div class="audioUploadRow">
              <a-upload :before-upload="beforeAudioUpload" :show-upload-list="false" accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg">
                <a-button><template #icon><UploadOutlined /></template>{{ locale === 'zh-CN' ? '选择音频' : 'Choose Audio' }}</a-button>
              </a-upload>
              <span :class="{ hasFile: audioFile }">{{ audioFile?.name || (locale === 'zh-CN' ? '支持 WAV、MP3、M4A、FLAC' : 'WAV, MP3, M4A, or FLAC') }}</span>
            </div>
            <a-space wrap class="playground-action-row">
              <a-button type="primary" :loading="audioBusy" :disabled="!audioFile" @click="runAsrTranscription"><template #icon><PlayCircleOutlined /></template>{{ locale === 'zh-CN' ? '开始转写' : 'Transcribe' }}</a-button>
              <a-button @click="clearPlaygroundCurrentMode">{{ t('playgroundClear') }}</a-button>
              <a-button @click="copyText(audioCurl)"><template #icon><CopyOutlined /></template>curl</a-button>
              <a-button :loading="audioBusy" @click="loadAudioModels">{{ locale === 'zh-CN' ? '探测服务' : 'Probe Service' }}</a-button>
            </a-space>
          </template>
          <template v-else-if="playgroundTab === 'speaker-verification'">
            <div class="speakerUploadGrid">
              <div class="audioUploadRow">
                <a-upload :before-upload="beforeSpeakerEnrollUpload" :show-upload-list="false" accept="audio/*,.wav,.mp3,.m4a,.flac">
                  <a-button><template #icon><UploadOutlined /></template>{{ locale === 'zh-CN' ? '注册音频' : 'Enrollment Audio' }}</a-button>
                </a-upload>
                <span :class="{ hasFile: speakerEnrollFile }">{{ speakerEnrollFile?.name || (locale === 'zh-CN' ? '已知说话人样本' : 'Known speaker sample') }}</span>
              </div>
              <div class="audioUploadRow">
                <a-upload :before-upload="beforeSpeakerTestUpload" :show-upload-list="false" accept="audio/*,.wav,.mp3,.m4a,.flac">
                  <a-button><template #icon><UploadOutlined /></template>{{ locale === 'zh-CN' ? '待比对音频' : 'Test Audio' }}</a-button>
                </a-upload>
                <span :class="{ hasFile: speakerTestFile }">{{ speakerTestFile?.name || (locale === 'zh-CN' ? '需要确认的说话人' : 'Speaker to verify') }}</span>
              </div>
            </div>
            <div class="speakerThresholdRow">
              <span>{{ locale === 'zh-CN' ? '判定阈值' : 'Threshold' }}</span>
              <a-input-number v-model:value="speakerThreshold" :min="0" :max="1" :step="0.01" />
              <a-slider v-model:value="speakerThreshold" :min="0" :max="1" :step="0.01" />
            </div>
            <a-space wrap class="playground-action-row">
              <a-button type="primary" :loading="audioBusy" :disabled="!speakerEnrollFile || !speakerTestFile" @click="runSpeakerVerification"><template #icon><PlayCircleOutlined /></template>{{ locale === 'zh-CN' ? '开始比对' : 'Verify Speaker' }}</a-button>
              <a-button @click="clearPlaygroundCurrentMode">{{ t('playgroundClear') }}</a-button>
              <a-button @click="copyText(speakerVerificationCurl)"><template #icon><CopyOutlined /></template>curl</a-button>
            </a-space>
          </template>
          <template v-else>
            <div class="audioCapabilityNotice">
              <b>{{ playgroundModeTitle }}</b>
              <p>{{ playgroundModeDescription }}</p>
              <span>{{ locale === 'zh-CN' ? '当前可检查模型挂载状态；实际推理需要对应专用服务端点。' : 'You can inspect model mounting now. Inference requires a dedicated service endpoint for this capability.' }}</span>
            </div>
            <a-space wrap class="playground-action-row">
              <a-button type="primary" :loading="audioBusy" @click="loadAudioModels"><template #icon><PlayCircleOutlined /></template>{{ locale === 'zh-CN' ? '探测运行时' : 'Probe Runtime' }}</a-button>
              <a-button @click="clearPlaygroundCurrentMode">{{ t('playgroundClear') }}</a-button>
            </a-space>
          </template>
        </a-card>
      </div>
    </section>

    <!-- 参数侧栏 -->
    <aside v-show="!rightPanelCollapsed" class="playground-side-panel">
      <div class="playgroundParamsPanel">
        <div class="playgroundParamsPanelHead">
          <h2>{{ locale === 'zh-CN' ? '模型参数' : 'Model Parameters' }}</h2>
        </div>
        <div class="playgroundParamsPanelBody">
          <div class="playgroundParamsField">
            <label>{{ locale === 'zh-CN' ? '本地模型' : 'Local Model' }}</label>
            <a-select
              :value="selectedPlaygroundModel?.id"
              :options="playgroundModelItems.map((item) => ({ label: item.model.display_name + ' · ' + playgroundListSubtitle(item), value: item.model.id }))"
              :placeholder="locale === 'zh-CN' ? '选择模型' : 'Select a model'"
              @change="selectPlaygroundModel"
            />
          </div>
          <div class="playground-mode-detection">
            <span>{{ locale === 'zh-CN' ? '测试类型' : 'Test Type' }}</span>
            <strong>{{ playgroundModeTitle }}</strong>
            <p>{{ playgroundModeDescription }}</p>
            <div class="playgroundRuntimeState">
              <i :class="{ ready: selectedPlaygroundDeploymentReady && (selectedPlaygroundDeployment?.status === 'running' || ['asr', 'tts', 'speaker-verification', 'speaker-diarization'].includes(playgroundTab)) }"></i>
              <span v-if="selectedPlaygroundDeployment">{{ selectedPlaygroundDeployment.status === 'running' ? (locale === 'zh-CN' ? '已发布，可测试' : 'Published and testable') : (locale === 'zh-CN' ? '模型仍在加载' : 'Model is loading') }}</span>
              <span v-else-if="['asr', 'tts', 'speaker-verification', 'speaker-diarization'].includes(playgroundTab)">FunASR Gateway</span>
              <span v-else>{{ locale === 'zh-CN' ? '尚未发布，先到模型发布页启动' : 'Not published. Start it from Model Publishing first.' }}</span>
            </div>
          </div>
          <div v-if="['chat', 'vision'].includes(playgroundTab)" class="playgroundParamsField">
            <label>{{ locale === 'zh-CN' ? '响应方式' : 'Response Mode' }}</label>
            <div class="playgroundSwitchField">
              <span>{{ locale === 'zh-CN' ? '流式输出' : 'Streaming' }}</span>
              <a-switch v-model:checked="playgroundStream" />
            </div>
          </div>
          <div v-if="['chat', 'vision'].includes(playgroundTab)" class="playgroundParamsField">
            <label>{{ locale === 'zh-CN' ? '系统提示词' : 'System Prompt' }}</label>
            <a-textarea v-model:value="playgroundSystemPrompt" :rows="4" />
          </div>
          <div v-if="['chat', 'vision'].includes(playgroundTab)" class="playgroundParamsField">
            <label>{{ t('temperature') }}</label>
            <div class="param-control"><a-input-number v-model:value="playgroundTemperature" :min="0" :max="2" :step="0.1" /><a-slider v-model:value="playgroundTemperature" :min="0" :max="2" :step="0.1" /></div>
          </div>
          <div v-if="['chat', 'vision'].includes(playgroundTab)" class="playgroundParamsField">
            <label>{{ t('topP') }}</label>
            <div class="param-control"><a-input-number v-model:value="playgroundTopP" :min="0" :max="1" :step="0.05" /><a-slider v-model:value="playgroundTopP" :min="0" :max="1" :step="0.05" /></div>
          </div>
          <div v-if="['chat', 'vision'].includes(playgroundTab)" class="playgroundParamsField">
            <label>{{ locale === 'zh-CN' ? '最大输出 Tokens' : 'Max Output Tokens' }}</label>
            <div class="param-control"><a-input-number v-model:value="playgroundMaxTokens" :min="128" :max="8192" :step="128" /><a-slider v-model:value="playgroundMaxTokens" :min="128" :max="8192" :step="128" /></div>
          </div>
          <div class="playground-params-note">
            <b>{{ locale === 'zh-CN' ? '说明' : 'Note' }}</b>
            <span>{{ locale === 'zh-CN' ? '测试输入和返回内容在中间区域；这里显示模型分类、发布状态和适用参数。' : 'Test input and output stay in the center. This panel shows capability, publish state, and applicable parameters.' }}</span>
          </div>
        </div>
      </div>
    </aside>
  </section>
</template>
