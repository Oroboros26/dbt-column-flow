import type { WebviewMessage } from '../../src/lineage/graphTypes';

declare function acquireVsCodeApi(): {
  postMessage: (msg: WebviewMessage) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

// Singleton — acquireVsCodeApi() can only be called once per webview session.
let _api: ReturnType<typeof acquireVsCodeApi> | null = null;

export function getVsCode() {
  if (!_api) {
    try { _api = acquireVsCodeApi(); } catch { /* browser preview — mock injected in HTML */ }
  }
  return _api;
}

export function postMessage(msg: WebviewMessage): void {
  getVsCode()?.postMessage(msg);
}
