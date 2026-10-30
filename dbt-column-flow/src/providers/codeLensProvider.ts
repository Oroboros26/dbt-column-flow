import * as vscode from 'vscode';
import type { LineageGraph } from '../lineage/graphTypes';

export class LineageCodeLensProvider implements vscode.CodeLensProvider {
  private graph: LineageGraph | null = null;

  setGraph(graph: LineageGraph | null): void {
    this.graph = graph;
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.graph) return [];

    // Match by file path suffix
    const filePath = document.uri.fsPath.replace(/\\/g, '/');
    const model = this.graph.models.find(
      (m) => m.filePath && filePath.endsWith(m.filePath.replace(/\\/g, '/')),
    );
    if (!model) return [];

    const lens = new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
      title: `$(type-hierarchy) Show column lineage`,
      command: 'voroColumnFlow.showLineageForModelId',
      arguments: [model.id],
    });

    return [lens];
  }
}
