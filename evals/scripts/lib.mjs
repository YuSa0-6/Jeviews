import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVALS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const JEVIEWS = resolve(EVALS, '..');
const WORK = join(EVALS, '.work');
export const config = JSON.parse(readFileSync(join(EVALS, 'repos.json'), 'utf8'));

export function repoDir(name) {
  const r = config.repos[name];
  return r.path === '.' ? JEVIEWS : resolve(JEVIEWS, config.ossRoot, name);
}
export function workDir(name, subset) {
  return join(WORK, `${name}-${subset}`);
}
export function evalDir(name) {
  const d = join(EVALS, name);
  mkdirSync(join(d, 'results'), { recursive: true });
  return d;
}
export function readJson(p, fallback) {
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
}
export function writeJson(p, v) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
}
export function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
}
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
export function hash32(s) {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
