const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');
const outDir = path.join(projectRoot, 'build');

async function ensureCssStub() {
  const cssDir = path.join(outDir, 'static', 'css');
  await fs.promises.mkdir(cssDir, { recursive: true });
  const cssPath = path.join(cssDir, 'main.css');
  const cssContent = `:root {
  color-scheme: light dark;
}

body {
  margin: 0;
  min-height: 100vh;
  background-color: transparent;
  color: var(--vscode-editor-foreground, #d4d4d4);
  font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
}
`;
  await fs.promises.writeFile(cssPath, cssContent, 'utf8');
}

async function build() {
  await fs.promises.rm(outDir, { recursive: true, force: true });

  await esbuild.build({
    entryPoints: [path.join(projectRoot, 'src', 'index.tsx')],
    bundle: true,
    minify: true,
    sourcemap: false,
    platform: 'browser',
    target: ['es2020'],
    format: 'iife',
    outfile: path.join(outDir, 'static', 'js', 'main.js'),
    loader: {
      '.ts': 'ts',
      '.tsx': 'tsx'
    },
    jsx: 'automatic',
    define: {
      'process.env.NODE_ENV': '"production"',
      global: 'window'
    },
    logLevel: 'info'
  });

  await ensureCssStub();
  console.log('✔ Webview assets built to', outDir);
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
