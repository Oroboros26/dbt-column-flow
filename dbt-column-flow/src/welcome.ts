import * as vscode from 'vscode';
import type { LineageGraph } from './lineage/graphTypes';

/**
 * Startup banner, rendered into a read-only pseudoterminal.
 *
 * A Pseudoterminal rather than an OutputChannel because output channels strip
 * ANSI escapes — and the edge legend below is meaningless without colour. The
 * terminal has no shell behind it: it writes once on open and ignores input.
 */

// ── Copy ──────────────────────────────────────────────────────────────────────

/** Replace with your own line. Kept short so it fits an 80-column terminal. */
const TAGLINE = 'Column-level lineage for dbt — parsed locally, nothing leaves your machine.';
const LINK = 'usevoro.com';

// ── ANSI ──────────────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

/** Truecolor foreground. VS Code's terminal supports 24-bit colour. */
function fg(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

const C = {
  logo: ['#60a5fa', '#4f96f7', '#3b82f6', '#2f76ea', '#2563eb'], // per logo row
  brand: fg('#3b82f6'),
  text: fg('#e4e4e7'),
  muted: fg('#a1a1aa'),
  faint: fg('#71717a'),
  ok: fg('#4ade80'),
  warn: fg('#fbbf24'),
  off: fg('#52525b'),
};

/** Edge categories, matching the colours the graph actually draws. */
const EDGE_LEGEND: { label: string; color: string }[] = [
  { label: 'passthrough', color: '#0066ff' },
  { label: 'rename', color: '#00cc66' },
  { label: 'transform', color: '#ffaa00' },
  { label: 'aggregate', color: '#9933ff' },
];

const CONFIDENCE_LEGEND: { label: string; color: string }[] = [
  { label: 'likely', color: '#94a3b8' },
  { label: 'type conflict', color: '#ef4444' },
  { label: 'unresolved', color: '#52525b' },
];

// ── Logo ──────────────────────────────────────────────────────────────────────

const LOGO_ROWS = [
  '█   █  █████  ████   █████',
  '█   █  █   █  █   █  █   █',
  '█   █  █   █  ████   █   █',
  ' █ █   █   █  █  █   █   █',
  '  █    █████  █   █  █████',
];

function renderLogo(): string[] {
  return LOGO_ROWS.map((row, i) => `  ${fg(C.logo[i] ?? C.logo[0])}${row}${RESET}`);
}

// ── Status ────────────────────────────────────────────────────────────────────

/** Real activation state, gathered by extension.ts after the first build. */
export interface WelcomeStatus {
  version: string;
  /** Resolved dbt project, or null when no dbt_project.yml was found. */
  project: { name: string; root: string } | null;
  /** Parsed manifest metadata, or null when manifest.json is missing/unreadable. */
  manifest: { dbtVersion: string; adapter: string } | null;
  hasCatalog: boolean;
  graph: LineageGraph | null;
}

type CheckState = 'ok' | 'warn' | 'off';

interface Check {
  state: CheckState;
  label: string;
  detail: string;
}

const MARK: Record<CheckState, string> = { ok: '✓', warn: '!', off: '·' };
const MARK_COLOR: Record<CheckState, string> = { ok: C.ok, warn: C.warn, off: C.off };

function buildChecks(s: WelcomeStatus): Check[] {
  const { project, manifest, graph } = s;
  const m = graph?.metadata;

  return [
    project
      ? { state: 'ok', label: 'dbt project', detail: `${project.name}  ${DIM}${project.root}${RESET}` }
      : { state: 'off', label: 'dbt project', detail: 'no dbt_project.yml in this workspace' },

    manifest
      ? {
          state: 'ok',
          label: 'manifest.json',
          detail: `dbt ${manifest.dbtVersion} · ${manifest.adapter || 'unknown'} dialect`,
        }
      : { state: 'warn', label: 'manifest.json', detail: 'not found — run `dbt compile`' },

    s.hasCatalog
      ? { state: 'ok', label: 'catalog.json', detail: 'exact columns and data types' }
      : {
          state: 'warn',
          label: 'catalog.json',
          detail: `not found — ${m?.inferredSchemas ?? 0} schemas inferred from SQL`,
        },

    m
      ? {
          state: 'ok',
          label: 'indexed',
          detail:
            `${m.totalModels.toLocaleString()} models · ` +
            `${m.totalSources.toLocaleString()} sources · ` +
            `${m.totalColumns.toLocaleString()} columns`,
        }
      : { state: 'off', label: 'indexed', detail: 'nothing loaded' },

    m
      ? {
          state: m.parseSuccessRate >= 80 ? 'ok' : 'warn',
          label: 'column lineage',
          detail:
            `${m.totalEdges.toLocaleString()} edges · ` +
            `${m.parseSuccessRate}% of models parsed`,
        }
      : { state: 'off', label: 'column lineage', detail: 'not built' },
  ];
}

// ── Render ────────────────────────────────────────────────────────────────────

const LABEL_WIDTH = 15;

function dots(items: { label: string; color: string }[]): string {
  return items.map((i) => `${fg(i.color)}●${RESET} ${C.muted}${i.label}${RESET}`).join('   ');
}

export function renderBanner(s: WelcomeStatus): string[] {
  const out: string[] = ['', ...renderLogo(), ''];

  out.push(`  ${BOLD}${C.brand}VORO Column Flow${RESET} ${C.faint}v${s.version}${RESET}`);
  out.push(`  ${C.muted}${TAGLINE}${RESET}`);
  out.push(`  ${C.faint}${LINK}${RESET}`);
  out.push('');

  for (const c of buildChecks(s)) {
    const mark = `${MARK_COLOR[c.state]}${MARK[c.state]}${RESET}`;
    const label = `${C.text}${c.label.padEnd(LABEL_WIDTH)}${RESET}`;
    out.push(`  ${mark} ${label}${C.muted}${c.detail}${RESET}`);
  }
  out.push('');

  out.push(`  ${BOLD}${C.text}Edge legend${RESET}`);
  out.push(`  ${dots(EDGE_LEGEND)}`);
  out.push(`  ${dots(CONFIDENCE_LEGEND)}`);
  out.push('');

  out.push(`  ${BOLD}${C.text}Getting started${RESET}`);
  for (const step of [
    'Click the V in the activity bar to open the Models list',
    'Pick a model, then set ↑ up / ↓ down depth to expand lineage',
    'Click any column to trace it across models',
    'Right-click a .sql file → Show Lineage for Current Model',
  ]) {
    out.push(`  ${C.brand}→${RESET} ${C.muted}${step}${RESET}`);
  }
  out.push('');

  // Only nag about setup when something is actually missing.
  if (!s.manifest) {
    out.push(
      `  ${C.warn}Requirement:${RESET} ${C.muted}run ${C.text}dbt compile${C.muted} in your project ` +
        `to produce target/manifest.json, then run VORO Column Flow: Refresh.${RESET}`,
    );
    out.push('');
  } else if (!s.hasCatalog) {
    out.push(
      `  ${C.warn}Recommended:${RESET} ${C.muted}run ${C.text}dbt docs generate${C.muted} for ` +
        `target/catalog.json — exact columns and data types instead of inference.${RESET}`,
    );
    out.push('');
  }

  return out;
}

// ── Terminal ──────────────────────────────────────────────────────────────────

class BannerPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  constructor(private readonly lines: string[]) {}

  open(): void {
    // Terminals need CRLF, not LF.
    this.writeEmitter.fire(this.lines.join('\r\n') + '\r\n');
  }

  close(): void {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
  // No handleInput: the terminal is read-only.
}

export function showWelcomeTerminal(status: WelcomeStatus): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: 'VORO',
    pty: new BannerPty(renderBanner(status)),
    iconPath: new vscode.ThemeIcon('type-hierarchy'),
  });
  // preserveFocus — reveal the panel without pulling the cursor out of the editor.
  terminal.show(true);
  return terminal;
}

/**
 * Whether to show the banner automatically. Default is once per installed
 * version, so upgrades re-announce themselves but daily use is not interrupted.
 */
export function shouldAutoShow(context: vscode.ExtensionContext, version: string): boolean {
  const mode = vscode.workspace
    .getConfiguration('voroColumnFlow')
    .get<'onInstall' | 'always' | 'never'>('welcomeBanner', 'onInstall');

  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return context.globalState.get<string>('voroColumnFlow.welcomeShownFor') !== version;
}

export async function markWelcomeShown(
  context: vscode.ExtensionContext,
  version: string,
): Promise<void> {
  await context.globalState.update('voroColumnFlow.welcomeShownFor', version);
}
