import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { workspaceResolver } from './workspace-resolver.mjs';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({
  entryPoints: {
    background: './src/background.ts',
    content: './src/content/index.ts',
    options: './src/options.ts'
  },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  plugins: [workspaceResolver],
  minify: false,
  logLevel: 'info'
});
for (const file of ['manifest.json', 'options.html', 'content.css', 'options.css']) {
  await cp(file, `dist/${file}`);
}
