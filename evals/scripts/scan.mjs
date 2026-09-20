// 部分集合を jeview で scan し、結果を evals/<repo>/results に残す。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { JEVIEWS, evalDir, git, run, workDir, writeJson } from './lib.mjs';

const [name, subset, concurrency = '6'] = process.argv.slice(2);
if (!name || !subset) throw new Error('usage: scan.mjs <repo> <subset> [concurrency]');
if (existsSync(join(JEVIEWS, '.env.local'))) process.loadEnvFile(join(JEVIEWS, '.env.local'));
const wd = workDir(name, subset);
const res = run('node', [join(JEVIEWS, 'dist/cli.js'), 'all', '--concurrency', concurrency], { cwd: wd, env: process.env });
if (!res.out) throw new Error(`scan produced no output: ${res.err.slice(-500)}`);
const out = JSON.parse(res.out);
const qv = out.files.flatMap((f) => f.checks).find((c) => c.questionVersion)?.questionVersion ?? 'unknown';
const commit = git(JEVIEWS, ['rev-parse', '--short', 'HEAD']).trim();
const dir = join(evalDir(name), 'results');
const prev = readdirSync(dir).filter((f) => f.startsWith(`${subset}.${qv}.`)).length;
const file = join(dir, `${subset}.${qv}.r${prev + 1}.json`);
writeJson(file, { meta: { repo: name, subset, questionVersion: qv, jeviewsCommit: commit, run: prev + 1 }, output: out });
const c = {}; for (const f of out.files) c[f.verdict ?? 'null'] = (c[f.verdict ?? 'null'] ?? 0) + 1;
console.log(`${name}/${subset} ${qv} r${prev + 1}: ${JSON.stringify(c)} status=${out.run.status} usd=${out.run.usage.costUsd} -> ${file.replace(JEVIEWS + '/', '')}`);
