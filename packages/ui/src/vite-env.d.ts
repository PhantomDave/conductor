/// <reference types="vite/client" />

declare const __VERSION__: string;

/** Injected by the Tauri desktop shell (withGlobalTauri); absent in a plain browser. */
interface Window {
  __TAURI__?: { core: { invoke<T = unknown>(cmd: string, args?: object): Promise<T> } };
}
