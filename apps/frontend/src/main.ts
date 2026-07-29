/**
 * @author Amuin
 * @created 2026-06-25
 * @description 应用入口 — 创建 Vue 实例，注册 Ant Design 插件并挂载到 #app。
 *              App entry point — creates Vue instance, registers Ant Design plugin, mounts to #app.
 */
import { createApp } from "vue";
import App from "./App.vue";
import Antd from "ant-design-vue";
import "ant-design-vue/dist/reset.css";
import "./styles.css";

// 声明 Electron API 类型
declare global {
  interface Window {
    electronAPI?: {
      isElectron: boolean;
      getAppVersion: () => Promise<string>;
      platform: string;
    };
  }
}

const app = createApp(App);
app.use(Antd);
app.mount("#app");
