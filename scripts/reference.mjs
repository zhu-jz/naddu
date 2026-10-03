import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function reference(mode, {depth = 5, commands, output} = {}) {
  const command = process.env.PYTHON || 'uv';
  const prefix = process.env.PYTHON ? [] : ['run', '--offline', '--no-project', 'python'];
  const args = [...prefix, '-B', path.join(root, 'scripts/reference.py'), mode, '--depth', String(depth)];
  if (output) args.push('--output', output);
  const result = spawnSync(command, args, {
    cwd: root, input: commands ? JSON.stringify(commands) : undefined,
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 3600000
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Reference failed: ${result.error || result.stderr || result.stdout}`);
  }
  return output ? null : JSON.parse(result.stdout);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] || 'benchmark';
  const depth = Number(process.argv[3] || 5);
  console.log(JSON.stringify(reference(mode, {depth})));
}
