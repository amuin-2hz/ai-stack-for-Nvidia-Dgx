<!--
  @author Amuin
  @created 2026-06-25
  @description 设置页面：左侧导航 + 右侧详情面板（通用/外观/开发者/运行时/网络/关于）。
               Settings page: left nav + right detail pane (General/Appearance/Developer/Runtime/Network/About).
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  locale, t, themeMode, setTheme, setLocale,
  managementPort, workbenchSettings, network, proxySettings, networkMessage,
  readyModels, runningDeployments, activeContainerCount, gpuSummary,
  system, adminToken, setAdminToken,
} from '../composables/useApp';
import {
  settingsTab, saveWorkbenchSettings, toggleLanAccess, saveProxySettings,
  proxyEnabled, proxyScope, proxyHttp, proxyHttps, proxyAll, proxyNo,
} from '../composables/useSettings';

const isDark = computed(() => themeMode.value === 'dark');
const lanAccessUrls = computed(() => {
  const port = system.value?.workbench?.active_management_port
    ?? workbenchSettings.value?.active_management_port
    ?? managementPort.value
    ?? 8888;
  return (system.value?.lan_addresses ?? []).map((address) => `http://${address}:${port}`);
});

const remoteAdminToken = ref(adminToken.value);
const tokenSaved = ref(false);
const activeBindAddress = computed(() => network.value?.active_bind_address ?? '0.0.0.0');
const desiredBindDiffers = computed(() => Boolean(
  network.value?.requires_restart
  && network.value.desired_bind_address
  && network.value.desired_bind_address !== network.value.active_bind_address
));

const proxyScopeOptions = computed(() => (locale.value === 'zh-CN'
  ? [
      { label: '全部', value: 'all' },
      { label: '仅 HF', value: 'huggingface' },
      { label: '仅 ModelScope', value: 'modelscope' },
    ]
  : [
      { label: 'All', value: 'all' },
      { label: 'HF only', value: 'huggingface' },
      { label: 'ModelScope only', value: 'modelscope' },
    ]
));

const settingsPanelMeta = computed(() => {
  const zh = locale.value === 'zh-CN';
  const meta = {
    general: { title: t('settingsGeneral'), desc: zh ? '常规体验、更新渠道与默认使用习惯。' : 'General experience, update channel, and default habits.' },
    appearance: { title: t('settingsAppearance'), desc: zh ? '界面主题、语言和视觉偏好。' : 'Theme, language, and visual preferences.' },
    developer: { title: t('settingsDeveloper'), desc: zh ? '调试、日志与外部调用能力。' : 'Debugging, logs, and external access capabilities.' },
    runtime: { title: t('settingsRuntime'), desc: zh ? '运行时资源、服务和模型发布概览。' : 'Runtime resources, services, and model publishing overview.' },
    network: { title: t('settingsNetwork'), desc: zh ? '局域网访问地址、监听范围和重启状态。' : 'LAN access address, bind scope, and restart status.' },
    proxy: { title: zh ? '下载代理' : 'Download Proxy', desc: zh ? '配置模型下载任务使用的代理。' : 'Configure the proxy used by model download tasks.' },
    about: { title: t('settingsAbout'), desc: zh ? '版本、构建信息和许可协议。' : 'Version, build information, and license.' },
  } as const;
  return meta[settingsTab.value];
});

function toggleTheme(checked: boolean | string | number) { setTheme(checked ? 'dark' : 'light'); }
function toggleLocale(checked: boolean | string | number) { setLocale(checked ? 'en-US' : 'zh-CN'); }
function saveRemoteAdminToken() {
  setAdminToken(remoteAdminToken.value);
  tokenSaved.value = true;
  globalThis.setTimeout(() => { tokenSaved.value = false; }, 2000);
}
</script>

<template>
  <section class="settingsWorkbench">
    <!-- 左侧导航 -->
    <aside class="settingsNavigator">
      <div class="settingsNavigatorHeader">{{ t('settings') }}</div>
      <div class="settingsNavigatorGroup">
        <button :class="['settingsNavButton', settingsTab==='general'?'isActive':'']" @click="settingsTab='general'"><span class="settingsNavDot"></span>{{ t('settingsGeneral') }}</button>
        <button :class="['settingsNavButton', settingsTab==='appearance'?'isActive':'']" @click="settingsTab='appearance'"><span class="settingsNavDot"></span>{{ t('settingsAppearance') }}</button>
        <button :class="['settingsNavButton', settingsTab==='developer'?'isActive':'']" @click="settingsTab='developer'"><span class="settingsNavDot"></span>{{ t('settingsDeveloper') }}</button>
        <button :class="['settingsNavButton', settingsTab==='runtime'?'isActive':'']" @click="settingsTab='runtime'"><span class="settingsNavDot"></span>{{ t('settingsRuntime') }}</button>
      </div>
      <div class="settingsNavigatorDivider"></div>
      <div class="settingsNavigatorGroup">
        <div class="settingsNavigatorTitle">{{ t('settingsSystem') }}</div>
        <button :class="['settingsNavButton', settingsTab==='network'?'isActive':'']" @click="settingsTab='network'"><span class="settingsNavDot"></span>{{ t('settingsNetwork') }}</button>
        <button :class="['settingsNavButton', settingsTab==='proxy'?'isActive':'']" @click="settingsTab='proxy'"><span class="settingsNavDot"></span>{{ locale==='zh-CN'?'下载代理':'Download Proxy' }}</button>
        <button :class="['settingsNavButton', settingsTab==='about'?'isActive':'']" @click="settingsTab='about'"><span class="settingsNavDot"></span>{{ t('settingsAbout') }}</button>
      </div>
      <div class="settingsAccountCard"><div class="settingsAccountAvatar">A</div><div><strong>{{ t('workstation') }}</strong><span>v1.1.1</span></div></div>
    </aside>

    <!-- 右侧详情 -->
    <section class="settingsDetailPane">
      <header class="settingsDetailHeader"><div><h1>{{ settingsPanelMeta.title }}</h1><p>{{ settingsPanelMeta.desc }}</p></div></header>
      <div class="settingsDetailBody">

        <!-- General -->
        <section v-if="settingsTab==='general'" class="settingsPanel isActive">
          <div class="settingsSection">
            <h2 class="settingsSectionTitle">{{ locale==='zh-CN'?'管理端口':'Management Port' }}</h2>
            <div class="settingsList">
              <div class="settingRow">
                <div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'端口号':'Port' }}</div><div class="settingDesc">{{ locale==='zh-CN'?'设置管理控制台的访问端口':'Set the management console access port' }}</div></div>
                <div class="settingControl settingInlineGroup"><a-input-number v-model:value="managementPort" :min="1024" :max="65535" style="width:120px" /><a-button type="primary" size="small" @click="saveWorkbenchSettings">{{ t('saveConfig') }}</a-button></div>
              </div>
              <div class="settingRow">
                <div class="settingMain"><div class="settingLabel">{{ t('consoleAddress') }}</div><div class="settingDesc">{{ system?.management_url ?? 'http://localhost:8888' }}</div></div>
                <div class="settingControl"><a-tag v-if="workbenchSettings?.requires_restart" color="gold">{{ t('restartRequired') }}</a-tag></div>
              </div>
            </div>
          </div>
        </section>

        <!-- Appearance -->
        <section v-if="settingsTab==='appearance'" class="settingsPanel isActive">
          <div class="settingsSection">
            <h2 class="settingsSectionTitle">{{ locale==='zh-CN'?'外观':'Appearance' }}</h2>
            <div class="settingsList">
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'主题模式':'Theme Mode' }}</div><div class="settingDesc">{{ locale==='zh-CN'?'切换浅色与深色界面主题':'Switch between light and dark themes' }}</div></div><div class="settingControl"><a-switch :checked="isDark" @change="toggleTheme" /></div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'界面语言':'Language' }}</div><div class="settingDesc">{{ locale==='zh-CN'?'切换中文与英文界面':'Switch between Chinese and English UI' }}</div></div><div class="settingControl"><a-switch :checked="locale==='en-US'" @change="toggleLocale" /></div></div>
            </div>
          </div>
        </section>

        <!-- Developer -->
        <section v-if="settingsTab==='developer'" class="settingsPanel isActive">
          <div class="settingsSection">
            <h2 class="settingsSectionTitle">{{ locale==='zh-CN'?'开发者':'Developer' }}</h2>
            <div class="settingsList">
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'调试模式':'Debug Mode' }}</div><div class="settingDesc">{{ locale==='zh-CN'?'开启后显示详细调试信息与日志':'Show detailed debug info and logs' }}</div></div><div class="settingControl"><a-switch :checked="false" :disabled="true" /></div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'日志级别':'Log Level' }}</div><div class="settingDesc">{{ locale==='zh-CN'?'控制后端日志输出详细程度':'Control backend log verbosity' }}</div></div><div class="settingControl"><a-select value="info" style="width:140px" :disabled="true"><a-select-option value="info">INFO</a-select-option><a-select-option value="debug">DEBUG</a-select-option></a-select></div></div>
            </div>
          </div>
          <div class="settingsSection">
            <h2 class="settingsSectionTitle">{{ locale==='zh-CN'?'API 密钥':'API Keys' }}</h2>
            <div class="settingsList">
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'远程管理令牌':'Remote Admin Token' }}</div><div class="settingDesc">{{ locale==='zh-CN'?'从服务器读取令牌并保存到当前浏览器，用于远程修改配置。':'Read the token from the server and save it in this browser for remote configuration.' }}</div></div><div class="settingControl settingInlineGroup"><a-input-password v-model:value="remoteAdminToken" :placeholder="locale==='zh-CN'?'输入管理令牌':'Enter admin token'" style="width:260px" /><a-button type="primary" size="small" @click="saveRemoteAdminToken">{{ tokenSaved ? (locale==='zh-CN'?'已保存':'Saved') : t('saveConfig') }}</a-button></div></div>
            </div>
          </div>
        </section>

        <!-- Runtime -->
        <section v-if="settingsTab==='runtime'" class="settingsPanel isActive">
          <div class="settingsSection">
            <h2 class="settingsSectionTitle">{{ locale==='zh-CN'?'运行时':'Runtime' }}</h2>
            <div class="settingsList">
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'就绪模型':'Ready Models' }}</div></div><div class="settingControl settingValueText">{{ readyModels }}</div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'运行中服务':'Running Services' }}</div></div><div class="settingControl settingValueText">{{ runningDeployments.length }}</div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'活动容器':'Active Containers' }}</div></div><div class="settingControl settingValueText">{{ activeContainerCount }}</div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ t('gpu') }}</div></div><div class="settingControl settingValueText">{{ gpuSummary }}</div></div>
            </div>
          </div>
        </section>

        <!-- Network -->
        <section v-if="settingsTab==='network'" class="settingsPanel isActive">
          <div class="settingsSection">
            <h2 class="settingsSectionTitle">{{ t('networkAccess') }}</h2>
            <div class="settingsList">
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'局域网访问':'LAN Access' }}</div><div class="settingDesc">{{ t('networkHint') }}</div></div><div class="settingControl"><a-switch :checked="network?.lan_access_enabled" @change="toggleLanAccess" /></div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'局域网地址':'LAN Address' }}</div><div class="settingDesc">{{ locale==='zh-CN'?'同一局域网内的设备使用这里的地址访问控制台。':'Devices on the same LAN use these addresses to reach the console.' }}</div></div><div class="settingControl settingValueStack"><template v-if="lanAccessUrls.length"><span v-for="url in lanAccessUrls" :key="url" class="settingMonoValue">{{ url }}</span></template><span v-else class="settingValueText">{{ locale==='zh-CN'?'未检测到局域网 IP':'No LAN IP detected' }}</span></div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'监听地址':'Bind Address' }}</div><div class="settingDesc">{{ locale==='zh-CN'?'0.0.0.0 表示监听所有网卡；127.0.0.1 表示仅本机。':'0.0.0.0 listens on all interfaces; 127.0.0.1 is local only.' }}</div></div><div class="settingControl settingValueStack"><span class="settingMonoValue">{{ activeBindAddress }}</span><a-tag v-if="network?.requires_restart" color="gold">{{ t('restartRequired') }}</a-tag></div></div>
              <div v-if="desiredBindDiffers" class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'重启后监听地址':'Bind After Restart' }}</div><div class="settingDesc">{{ locale==='zh-CN'?'当前开关已保存，重启本机 Web 服务后切换到这个地址。':'The switch is saved and will apply after restarting the local web service.' }}</div></div><div class="settingControl settingValueStack"><span class="settingMonoValue">{{ network?.desired_bind_address }}</span></div></div>
            </div>
            <div v-if="networkMessage" class="settingMessage">{{ networkMessage }}</div>
          </div>
        </section>

        <!-- Download Proxy -->
        <section v-if="settingsTab==='proxy'" class="settingsPanel isActive">
          <div class="settingsSection">
            <h2 class="settingsSectionTitle">{{ locale==='zh-CN'?'下载代理':'Download Proxy' }}</h2>
            <div class="settingsList">
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'启用下载代理':'Enable Download Proxy' }}</div><div class="settingDesc">{{ locale==='zh-CN'?'用于下载任务；保存后新的下载或重试生效。':'Used by download tasks. Applies to new downloads or retries.' }}</div></div><div class="settingControl"><a-switch v-model:checked="proxyEnabled" /></div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'适用范围':'Scope' }}</div><div class="settingDesc">{{ locale==='zh-CN'?'选择代理影响 HF、ModelScope，或两者。':'Choose whether the proxy applies to HF, ModelScope, or both.' }}</div></div><div class="settingControl"><a-segmented v-model:value="proxyScope" :options="proxyScopeOptions" /></div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">HTTP_PROXY</div><div class="settingDesc">{{ locale==='zh-CN'?'例如 http://127.0.0.1:7890':'For example http://127.0.0.1:7890' }}</div></div><div class="settingControl"><a-input v-model:value="proxyHttp" :disabled="!proxyEnabled" placeholder="http://127.0.0.1:7890" style="width:260px" /></div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">HTTPS_PROXY</div><div class="settingDesc">{{ locale==='zh-CN'?'HTTPS 下载请求使用的代理':'Proxy for HTTPS download requests' }}</div></div><div class="settingControl"><a-input v-model:value="proxyHttps" :disabled="!proxyEnabled" placeholder="http://127.0.0.1:7890" style="width:260px" /></div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">ALL_PROXY</div><div class="settingDesc">{{ locale==='zh-CN'?'可选，支持 socks5:// 或 socks5h://':'Optional; supports socks5:// or socks5h://' }}</div></div><div class="settingControl"><a-input v-model:value="proxyAll" :disabled="!proxyEnabled" placeholder="socks5://127.0.0.1:7890" style="width:260px" /></div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">NO_PROXY</div><div class="settingDesc">{{ locale==='zh-CN'?'本机与局域网地址始终直连；此处可追加其他不走代理的主机':'Local and private-network addresses always connect directly; add other bypass hosts here' }}</div></div><div class="settingControl"><a-input v-model:value="proxyNo" :disabled="!proxyEnabled" placeholder="localhost,127.0.0.1,::1,192.168.0.0/16" style="width:260px" /></div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'配置文件':'Config File' }}</div><div class="settingDesc">{{ proxySettings?.env_path ?? 'configs/proxy.env' }}</div></div><div class="settingControl"><a-button type="primary" size="small" @click="saveProxySettings">{{ t('saveConfig') }}</a-button></div></div>
            </div>
            <div v-if="networkMessage" class="settingMessage">{{ networkMessage }}</div>
          </div>
        </section>

        <!-- About -->
        <section v-if="settingsTab==='about'" class="settingsPanel isActive">
          <div class="settingsSection">
            <h2 class="settingsSectionTitle">{{ locale==='zh-CN'?'关于':'About' }}</h2>
            <div class="settingsList">
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'版本':'Version' }}</div></div><div class="settingControl settingValueText">v1.1.1</div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'构建日期':'Build Date' }}</div></div><div class="settingControl settingValueText">2026.06</div></div>
              <div class="settingRow"><div class="settingMain"><div class="settingLabel">{{ locale==='zh-CN'?'许可协议':'License' }}</div></div><div class="settingControl settingValueText">MIT</div></div>
            </div>
          </div>
        </section>
      </div>
    </section>
  </section>
</template>
