import { createApp } from "vue";
import App from "./App.vue";

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
app.mount("#app");
