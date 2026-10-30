import * as vscode from 'vscode';
import * as path from 'path';

export class ArtifactWatcher implements vscode.Disposable {
  private watchers: vscode.FileSystemWatcher[] = [];

  watch(manifestPath: string, onChange: () => void): void {
    this.dispose();

    // Watch manifest.json
    const manifestUri = vscode.Uri.file(manifestPath);
    const manifestDir = path.dirname(manifestPath);

    const manifestWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(manifestDir, 'manifest.json'),
    );
    manifestWatcher.onDidChange(onChange);
    manifestWatcher.onDidCreate(onChange);
    this.watchers.push(manifestWatcher);

    // Watch catalog.json in the same directory
    const catalogWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(manifestDir, 'catalog.json'),
    );
    catalogWatcher.onDidChange(onChange);
    catalogWatcher.onDidCreate(onChange);
    this.watchers.push(catalogWatcher);

    void manifestUri; // referenced to suppress unused warning
  }

  dispose(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
  }
}
