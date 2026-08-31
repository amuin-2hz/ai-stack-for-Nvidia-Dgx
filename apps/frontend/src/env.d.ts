/**
 * @author Amuin
 * @created 2026-06-25
 * @description Vite 环境类型声明 — Vue SFC 模块类型与 Vite 客户端类型引用。
 *              Vite env type declarations — Vue SFC module type and Vite client type reference.
 */
/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
