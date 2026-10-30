import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !isWatch,
};

const webviewConfig = {
  entryPoints: ['webview-ui/src/index.tsx'],
  bundle: true,
  outfile: 'dist/webview/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2021',
  sourcemap: true,
  minify: !isWatch,
  jsx: 'automatic',
  jsxImportSource: 'react',
  loader: {
    '.css': 'text',
    '.tsx': 'tsx',
    '.ts': 'ts',
  },
};

async function build() {
  if (isWatch) {
    const [extCtx, webCtx] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('[watch] Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);
    console.log('[build] Done.');
  }
}

build().catch((err) => { console.error(err); process.exit(1); });
