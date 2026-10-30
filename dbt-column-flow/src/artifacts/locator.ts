import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface ProjectInfo {
  projectRoot: string;
  projectName: string;
  manifestPath: string;
  catalogPath: string | null;   // null if catalog.json not present
  hasManifest: boolean;
}

export class ArtifactLocator {
  async findProject(context: vscode.ExtensionContext): Promise<ProjectInfo | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) return null;

    // If there's a saved project root, use it
    const saved = context.workspaceState.get<string>('voroColumnFlow.projectRoot');
    if (saved) {
      const info = await this.buildInfo(saved);
      if (info) return info;
    }

    // Check each workspace folder root directly first — this is the common case
    // (dbt_project.yml at the workspace root) and doesn't depend on VS Code's
    // file-search index, which can still be warming up right after a large
    // workspace is opened. Relying on findFiles alone for this case caused
    // false negatives on first activation for big dbt projects.
    for (const folder of workspaceFolders) {
      const info = await this.buildInfo(folder.uri.fsPath);
      if (info) {
        await context.workspaceState.update('voroColumnFlow.projectRoot', folder.uri.fsPath);
        return info;
      }
    }

    // Not at any workspace root — search for a nested dbt_project.yml instead.
    const projectFiles = await vscode.workspace.findFiles(
      '**/dbt_project.yml',
      '**/node_modules/**',
    );

    if (projectFiles.length === 0) return null;

    if (projectFiles.length === 1) {
      const root = path.dirname(projectFiles[0].fsPath);
      const info = await this.buildInfo(root);
      if (info) {
        await context.workspaceState.update('voroColumnFlow.projectRoot', root);
        return info;
      }
    }

    // Multiple dbt projects — ask user to pick
    const picks = projectFiles.map((f) => ({
      label: path.dirname(f.fsPath).split(path.sep).slice(-2).join(path.sep),
      detail: path.dirname(f.fsPath),
    }));

    const chosen = await vscode.window.showQuickPick(picks, {
      placeHolder: 'Multiple dbt projects found — select one',
    });
    if (!chosen) return null;

    const info = await this.buildInfo(chosen.detail);
    if (info) {
      await context.workspaceState.update('voroColumnFlow.projectRoot', chosen.detail);
    }
    return info;
  }

  private async buildInfo(projectRoot: string): Promise<ProjectInfo | null> {
    // Verify dbt_project.yml exists
    try {
      await fs.access(path.join(projectRoot, 'dbt_project.yml'));
    } catch {
      return null;
    }

    const config = vscode.workspace.getConfiguration('voroColumnFlow');
    const targetDir = config.get<string>('targetPath', 'target');
    const manifestPath = path.join(projectRoot, targetDir, 'manifest.json');
    const catalogPath = path.join(projectRoot, targetDir, 'catalog.json');

    const hasManifest = await fileExists(manifestPath);
    const hasCatalog = await fileExists(catalogPath);

    // Extract project name from dbt_project.yml (best effort)
    let projectName = path.basename(projectRoot);
    try {
      const yml = await fs.readFile(path.join(projectRoot, 'dbt_project.yml'), 'utf-8');
      const match = yml.match(/^name:\s*['"]?([^'"\n]+)['"]?/m);
      if (match) projectName = match[1].trim();
    } catch { /* ignore */ }

    return {
      projectRoot,
      projectName,
      manifestPath,
      catalogPath: hasCatalog ? catalogPath : null,
      hasManifest,
    };
  }
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
