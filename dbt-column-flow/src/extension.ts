import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ArtifactLocator } from './artifacts/locator';
import { ManifestParser } from './artifacts/manifestParser';
import { CatalogParser } from './artifacts/catalogParser';
import { ArtifactWatcher } from './artifacts/watcher';
import { ColumnLineageBuilder } from './lineage/columnLineageBuilder';
import { resolveEdgeWithAI, type ApiFormat } from './lineage/llmResolver';
import { LineageWebviewProvider } from './webview/webviewProvider';
import { ModelsTreeProvider } from './providers/modelsTreeProvider';
import { LineageCodeLensProvider } from './providers/codeLensProvider';
import {
  showWelcomeTerminal,
  shouldAutoShow,
  markWelcomeShown,
  type WelcomeStatus,
} from './welcome';
import type { AiEdgeQuery, LineageGraph } from './lineage/graphTypes';

const AI_SECRET_KEY = 'voroColumnFlow.aiApiKey';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('VORO Column Flow');
  context.subscriptions.push(output);

  const locator = new ArtifactLocator();
  const manifestParser = new ManifestParser();
  const catalogParser = new CatalogParser();
  const lineageBuilder = new ColumnLineageBuilder();
  const watcher = new ArtifactWatcher();
  context.subscriptions.push(watcher);

  const treeProvider = new ModelsTreeProvider();
  const codeLensProvider = new LineageCodeLensProvider();

  vscode.window.registerTreeDataProvider('voroColumnFlow.modelsTree', treeProvider);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, codeLensProvider),
  );

  const webviewProvider = new LineageWebviewProvider(
    context.extensionUri,
    async (filePath: string) => {
      const uri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(uri);
    },
    async (dataUrl: string) => {
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(projectInfo?.projectRoot ?? '', 'lineage.png')),
        filters: { PNG: ['png'] },
      });
      if (!saveUri) return;
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      await fs.writeFile(saveUri.fsPath, Buffer.from(base64, 'base64'));
      vscode.window.showInformationMessage(`Saved: ${saveUri.fsPath}`);
    },
    (query: AiEdgeQuery) => handleResolveEdgeWithAI(query),
    isAiEnabled,
  );
  context.subscriptions.push(webviewProvider);

  let projectInfo = await locator.findProject(context);
  let currentGraph: LineageGraph | null = null;
  // Kept for the welcome banner, which reports what was actually loaded.
  let manifestInfo: WelcomeStatus['manifest'] = null;

  // ── Optional AI fallback ────────────────────────────────────────────────────
  // Off by default. Only called when the user both enables it in settings and
  // clicks "Resolve with AI" on a specific unresolved edge — never in bulk,
  // never on load.

  function isAiEnabled(): boolean {
    return vscode.workspace.getConfiguration('voroColumnFlow').get<boolean>('ai.enabled', false);
  }

  async function getAiConfig(): Promise<{ baseUrl: string; apiFormat: ApiFormat; model: string; apiKey: string; azureApiVersion: string } | null> {
    if (!isAiEnabled()) return null;
    const cfg = vscode.workspace.getConfiguration('voroColumnFlow');
    const baseUrl = cfg.get<string>('ai.baseUrl', '').trim();
    const apiFormat = cfg.get<ApiFormat>('ai.apiFormat', 'openai');
    const model = cfg.get<string>('ai.model', '').trim();
    const azureApiVersion = cfg.get<string>('ai.azureApiVersion', '2024-05-01-preview').trim();
    const apiKey = await context.secrets.get(AI_SECRET_KEY);
    if (!baseUrl || !model || !apiKey) return null;
    return { baseUrl, apiFormat, model, apiKey, azureApiVersion };
  }

  async function handleResolveEdgeWithAI(query: AiEdgeQuery): Promise<void> {
    const config = await getAiConfig();
    if (!config) {
      webviewProvider.sendAiError(
        query.edgeId,
        'AI resolution is not fully set up — enable it and set a base URL, model, and API key ' +
        '(command: "VORO Column Flow: Set AI API Key").',
      );
      return;
    }
    try {
      const targetModel = currentGraph?.models.find((m) => m.id === query.targetModelId);
      let targetSql: string | null = null;
      if (targetModel?.filePath) {
        try { targetSql = await fs.readFile(targetModel.filePath, 'utf8'); }
        catch { /* SQL is a nice-to-have for the prompt; proceed without it */ }
      }
      const result = await resolveEdgeWithAI(config, query, targetSql);
      webviewProvider.sendAiResult(query.edgeId, result);
    } catch (err) {
      webviewProvider.sendAiError(query.edgeId, err instanceof Error ? err.message : String(err));
    }
  }

  async function buildLineage(): Promise<LineageGraph | null> {
    if (!projectInfo?.hasManifest) {
      output.appendLine('manifest.json not found. Run `dbt compile` or `dbt docs generate`.');
      return null;
    }

    try {
      const manifest = await manifestParser.parse(projectInfo.manifestPath);
      if (!manifest) { output.appendLine('Failed to parse manifest.json'); return null; }
      manifestInfo = { dbtVersion: manifest.dbtVersion, adapter: manifest.adapterType };

      const catalog = projectInfo.catalogPath
        ? await catalogParser.parse(projectInfo.catalogPath)
        : null;

      const graph = lineageBuilder.build(manifest, catalog, projectInfo.projectRoot);

      output.appendLine(
        `Lineage: ${graph.metadata.totalModels} models, ` +
        `${graph.metadata.totalSources} sources, ` +
        `${graph.metadata.totalColumns} columns, ` +
        `${graph.metadata.totalEdges} edges, ` +
        `${graph.metadata.parseSuccessRate}% parse rate` +
        ` (${manifest.adapterType || 'unknown'} dialect)`,
      );
      if (!catalog) {
        output.appendLine(
          `No catalog.json found. ${graph.metadata.inferredSchemas ?? 0} upstream schemas were ` +
          'inferred from downstream SQL. Run `dbt docs generate` for exact columns and data types.',
        );
      }
      if (graph.metadata.dropReasons) {
        output.appendLine(`Edge diagnostics: ${JSON.stringify(graph.metadata.dropReasons)}`);
      }
      return graph;
    } catch (err) {
      output.appendLine(`Error: ${err}`);
      return null;
    }
  }

  async function refreshAll(focusModelId?: string): Promise<void> {
    if (webviewProvider.isOpen()) webviewProvider.setLoading();
    if (!projectInfo) {
      projectInfo = await locator.findProject(context);
      if (projectInfo) watcher.watch(projectInfo.manifestPath, () => void refreshAll());
    }
    currentGraph = await buildLineage();
    treeProvider.setGraph(currentGraph);
    codeLensProvider.setGraph(currentGraph);
    if (webviewProvider.isOpen()) {
      if (currentGraph) webviewProvider.updateGraph(currentGraph, focusModelId);
      else webviewProvider.setError('Run `dbt compile` to generate manifest.json');
    }
  }

  // Watch manifest for changes
  if (projectInfo) {
    watcher.watch(projectInfo.manifestPath, () => void refreshAll());
    currentGraph = await buildLineage();
    treeProvider.setGraph(currentGraph);
    codeLensProvider.setGraph(currentGraph);
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('voroColumnFlow.showLineage', async () => {
      webviewProvider.show(currentGraph);
    }),

    vscode.commands.registerCommand('voroColumnFlow.showLineageForModel', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const filePath = editor.document.uri.fsPath.replace(/\\/g, '/');
      const model = currentGraph?.models.find(
        (m) => m.filePath && filePath.endsWith(m.filePath.replace(/\\/g, '/')),
      );
      webviewProvider.show(currentGraph, model?.id);
    }),

    vscode.commands.registerCommand('voroColumnFlow.showLineageForModelId', (modelId: string) => {
      webviewProvider.show(currentGraph, modelId);
    }),

    vscode.commands.registerCommand('voroColumnFlow.refresh', () => void refreshAll()),

    vscode.commands.registerCommand('voroColumnFlow.exportPng', () => {
      if (webviewProvider.isOpen()) {
        webviewProvider.show(currentGraph);
      }
    }),

    vscode.commands.registerCommand('voroColumnFlow.showWelcome', () => {
      showWelcomeTerminal(welcomeStatus());
    }),

    vscode.commands.registerCommand('voroColumnFlow.switchProject', async () => {
      await context.workspaceState.update('voroColumnFlow.projectRoot', undefined);
      projectInfo = await locator.findProject(context);
      if (projectInfo) {
        watcher.watch(projectInfo.manifestPath, () => void refreshAll());
        await refreshAll();
      }
    }),

    vscode.commands.registerCommand('voroColumnFlow.setAiApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'VORO Column Flow: AI API Key',
        prompt: 'Stored in VS Code\'s secret storage, never written to settings.json.',
        password: true,
        ignoreFocusOut: true,
      });
      if (!key) return;
      await context.secrets.store(AI_SECRET_KEY, key);
      vscode.window.showInformationMessage('VORO Column Flow: AI API key saved.');
    }),

    vscode.commands.registerCommand('voroColumnFlow.clearAiApiKey', async () => {
      const existing = await context.secrets.get(AI_SECRET_KEY);
      if (!existing) {
        vscode.window.showInformationMessage('VORO Column Flow: No AI API key is stored.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        'Delete the stored AI API key from this machine\'s secret storage?',
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;
      await context.secrets.delete(AI_SECRET_KEY);
      vscode.window.showInformationMessage('VORO Column Flow: AI API key cleared.');
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('voroColumnFlow.ai') && webviewProvider.isOpen()) webviewProvider.sendAiStatus();
    }),
    context.secrets.onDidChange((e) => {
      if (e.key === AI_SECRET_KEY && webviewProvider.isOpen()) webviewProvider.sendAiStatus();
    }),
  );

  // ── Welcome banner ─────────────────────────────────────────────────────────
  // Runs last, so it reports what the activation above actually loaded rather
  // than what it was about to attempt.

  const version = String(
    (context.extension.packageJSON as { version?: string }).version ?? '0.0.0',
  );

  function welcomeStatus(): WelcomeStatus {
    return {
      version,
      project: projectInfo
        ? { name: projectInfo.projectName, root: projectInfo.projectRoot }
        : null,
      manifest: manifestInfo,
      hasCatalog: currentGraph?.metadata.hasCatalog ?? false,
      graph: currentGraph,
    };
  }

  if (shouldAutoShow(context, version)) {
    showWelcomeTerminal(welcomeStatus());
    await markWelcomeShown(context, version);
  }
}

export function deactivate(): void {
  // Cleanup handled via subscriptions
}
