import * as vscode from 'vscode';
import { getWebviewContent } from './getWebviewContent';
import type { AiEdgeQuery, AiEdgeResult, LineageGraph, ExtensionMessage, WebviewMessage } from '../lineage/graphTypes';

export class LineageWebviewProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onOpenFile: (filePath: string) => void,
    private readonly onExportPng: (dataUrl: string) => void,
    private readonly onResolveEdgeWithAI: (query: AiEdgeQuery) => Promise<void>,
    private readonly isAiEnabled: () => boolean,
  ) {}

  show(graph: LineageGraph | null, focusModelId?: string): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'dbtColumnFlow',
        'dbt Column Flow',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.extensionUri],
        },
      );
      this.panel.webview.html = getWebviewContent(this.panel.webview, this.extensionUri);

      this.panel.webview.onDidReceiveMessage(
        (msg: WebviewMessage) => {
          if (msg.type === 'ready') {
            if (graph) this.sendGraph(graph, focusModelId);
            else this.sendMessage({ type: 'setLoading' });
            this.sendAiStatus();
          } else if (msg.type === 'openFile') {
            this.onOpenFile(msg.filePath);
          } else if (msg.type === 'exportPng') {
            this.onExportPng(msg.dataUrl);
          } else if (msg.type === 'resolveEdgeWithAI') {
            void this.onResolveEdgeWithAI(msg.query);
          } else if (msg.type === 'openAiSettings') {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'voroColumnFlow.ai');
          } else if (msg.type === 'setAiApiKey') {
            void vscode.commands.executeCommand('voroColumnFlow.setAiApiKey').then(() => this.sendAiStatus());
          } else if (msg.type === 'clearAiApiKey') {
            void vscode.commands.executeCommand('voroColumnFlow.clearAiApiKey').then(() => this.sendAiStatus());
          }
        },
        undefined,
        this.disposables,
      );

      this.panel.onDidDispose(() => {
        this.panel = null;
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
      });
    }

    if (graph) this.sendGraph(graph, focusModelId);
  }

  setLoading(): void {
    this.sendMessage({ type: 'setLoading' });
  }

  setError(message: string): void {
    this.sendMessage({ type: 'setError', message });
  }

  updateGraph(graph: LineageGraph, focusModelId?: string): void {
    if (!this.panel) return;
    this.sendGraph(graph, focusModelId);
  }

  focusModel(modelId: string): void {
    this.sendMessage({ type: 'focusModel', modelId });
  }

  isOpen(): boolean {
    return this.panel !== null;
  }

  sendAiStatus(): void {
    this.sendMessage({ type: 'aiStatus', enabled: this.isAiEnabled() });
  }

  sendAiResult(edgeId: string, result: AiEdgeResult): void {
    this.sendMessage({ type: 'aiResolveResult', edgeId, result });
  }

  sendAiError(edgeId: string, message: string): void {
    this.sendMessage({ type: 'aiResolveError', edgeId, message });
  }

  private sendGraph(graph: LineageGraph, focusModelId?: string): void {
    this.sendMessage({ type: 'setGraph', graph, focusModelId });
  }

  private sendMessage(msg: ExtensionMessage): void {
    this.panel?.webview.postMessage(msg);
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
