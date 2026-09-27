import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Resolve project source files with Node's file API.
export const workspaceResolver = {
  name: 'workspace-resolver',
  setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (args.path.startsWith('node:')) return { path: args.path, external: true };
      const base = args.resolveDir || process.cwd();
      const resolved = path.resolve(base, args.path);
      return { path: path.extname(resolved) ? resolved : `${resolved}.ts`, namespace: 'workspace-file' };
    });
    build.onLoad({ filter: /.*/, namespace: 'workspace-file' }, async args => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'ts',
      resolveDir: path.dirname(args.path)
    }));
  }
};
