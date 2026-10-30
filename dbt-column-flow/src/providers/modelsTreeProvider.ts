import * as vscode from 'vscode';
import type { LineageGraph, ModelNode } from '../lineage/graphTypes';

class ModelItem extends vscode.TreeItem {
  constructor(public readonly model: ModelNode) {
    super(model.name, vscode.TreeItemCollapsibleState.None);
    this.tooltip = `${model.schema}.${model.name} (${model.layer})`;
    this.description = model.layer;
    this.iconPath = model.resourceType === 'source'
      ? new vscode.ThemeIcon('database')
      : new vscode.ThemeIcon('symbol-module');
    this.command = {
      command: 'voroColumnFlow.showLineageForModelId',
      title: 'Show Lineage',
      arguments: [model.id],
    };
    this.contextValue = 'dbtModel';
  }
}

export class ModelsTreeProvider implements vscode.TreeDataProvider<ModelItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private models: ModelNode[] = [];

  setGraph(graph: LineageGraph | null): void {
    this.models = graph?.models ?? [];
    this._onDidChange.fire();
  }

  getTreeItem(element: ModelItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ModelItem[] {
    return this.models
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => new ModelItem(m));
  }
}
