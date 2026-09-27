import { build } from 'esbuild';
import { readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { workspaceResolver } from './workspace-resolver.mjs';

const outputDir = '.test-dist';
await rm(outputDir, { recursive: true, force: true });
const sources = (await readdir('tests')).filter(name => name.endsWith('.test.ts')).map(name => `./tests/${name}`);
await build({ entryPoints: sources, outdir: outputDir, bundle: true, format: 'esm', platform: 'node', outExtension: { '.js': '.mjs' }, plugins: [workspaceResolver], logLevel: 'silent' });
const files = (await readdir(outputDir)).filter(name => name.endsWith('.mjs')).map(name => `${outputDir}/${name}`);
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
const code = await new Promise(resolve => child.on('exit', resolve));
process.exitCode = code ?? 1;
