/**
 * @author Amuin
 * @created 2026-06-25
 * @description 设置（Settings）页面本地状态、工作台设置保存与网络切换。
 *              Settings page-local state, workbench config save, and network toggle.
 */
import { ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import {
  locale, t, api, refresh, managementPort, workbenchSettings, network, networkMessage, proxySettings
} from './useApp';

/** 设置页当前选中的 Tab */
export const settingsTab = ref<'general' | 'appearance' | 'developer' | 'runtime' | 'network' | 'proxy' | 'about'>('general');
export const proxyEnabled = ref(false);
export const proxyScope = ref<import('../types').ProxyScope>('all');
export const proxyHttp = ref('');
export const proxyHttps = ref('');
export const proxyAll = ref('');
export const proxyNo = ref('localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16');

const proxyDirty = ref(false);
let applyingProxySettings = false;

function applyProxySettings(settings: import('../types').ProxySettings | null) {
  applyingProxySettings = true;
  proxyEnabled.value = Boolean(settings?.enabled);
  proxyScope.value = settings?.scope ?? 'all';
  proxyHttp.value = settings?.http_proxy ?? '';
  proxyHttps.value = settings?.https_proxy ?? '';
  proxyAll.value = settings?.all_proxy ?? '';
  proxyNo.value = settings?.no_proxy || 'localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16';
  globalThis.setTimeout(() => { applyingProxySettings = false; }, 0);
}

watch(proxySettings, (settings) => {
  if (!proxyDirty.value) applyProxySettings(settings);
}, { immediate: true });

watch([proxyEnabled, proxyScope, proxyHttp, proxyHttps, proxyAll, proxyNo], () => {
  if (!applyingProxySettings) proxyDirty.value = true;
});

/**
 * 保存工作台设置（管理端口）。
 * Save workbench settings (management port).
 */
export async function saveWorkbenchSettings() {
  try {
    const payload = await api<import('../types').WorkbenchSettings>('/settings/workbench', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ management_port: managementPort.value })
    });
    workbenchSettings.value = payload;
    message.success(
      payload.requires_restart
        ? (locale.value === 'zh-CN' ? '已保存，重启前端服务后生效。' : 'Saved. Restart the frontend service to apply.')
        : t('configSaved')
    );
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 切换局域网访问开关。
 * Toggle LAN access on/off.
 */
export async function toggleLanAccess() {
  if (!network.value) return;
  networkMessage.value = t('savingNetwork');
  try {
    const payload = await api<import('../types').NetworkSettings>('/settings/network', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lan_access_enabled: !network.value.lan_access_enabled })
    });
    network.value = payload;
    networkMessage.value = payload.requires_restart
      ? t('savedNeedsRestart') + payload.desired_bind_address
      : t('savedActive');
    networkMessage.value += ' ' + t('networkHint');
  } catch (error) {
    networkMessage.value = String(error);
  }
}


/**
 * 保存下载代理设置。
 * Save download proxy settings.
 */
export async function saveProxySettings() {
  networkMessage.value = locale.value === 'zh-CN' ? '正在保存下载代理...' : 'Saving download proxy...';
  try {
    const payload = await api<import('../types').ProxySettings>('/settings/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: proxyEnabled.value,
        scope: proxyScope.value,
        http_proxy: proxyHttp.value,
        https_proxy: proxyHttps.value,
        all_proxy: proxyAll.value,
        no_proxy: proxyNo.value
      })
    });
    proxyDirty.value = false;
    applyProxySettings(payload);
    proxySettings.value = payload;
    networkMessage.value = locale.value === 'zh-CN'
      ? '下载代理已保存。新的下载/重试会使用该配置。'
      : 'Download proxy saved. New downloads/retries will use it.';
  } catch (error) {
    networkMessage.value = error instanceof Error ? error.message : String(error);
  }
}
