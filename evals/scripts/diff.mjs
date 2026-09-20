// scan 結果と期待値の食い違い (fp / fn) を観点ごとに並べる。調整のときに見る。
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { evalDir, readJson } from './lib.mjs';

function label(said, want) {
  if (said === want) return null;
  return said ? 'FP' : 'FN';
}

function row(f, c, t) {
  const tag = label(c.verdict === 'NG', t.truth === 'problem');
  if (!tag) return null;
  const p = c.problem?.probability?.toFixed(2);
  const n = c.needsContext?.probability?.toFixed(2);
  return `${tag} ${c.checkId.padEnd(24)} ${f.path.padEnd(58)} p=${p} n=${n} ${c.reason ?? ''} ${t.detail ?? ''}`;
}

function rowsFor(f, truth) {
  return f.checks
    .filter((c) => c.applicable && truth[c.checkId] && c.verdict !== null)
    .map((c) => row(f, c, truth[c.checkId]))
    .filter(Boolean);
}

function pickResult(dir, subset, which) {
  const files = readdirSync(dir).filter((f) => f.startsWith(`${subset}.`)).sort();
  return which === 'latest' ? files.at(-1) : which;
}

function main() {
  const [name, subset, which = 'latest'] = process.argv.slice(2);
  const dir = join(evalDir(name), 'results');
  const rf = pickResult(dir, subset, which);
  const { output } = readJson(join(dir, rf));
  const expected = readJson(join(evalDir(name), `${subset}.expected.json`));
  const rows = output.files.flatMap((f) => rowsFor(f, expected.files[f.path] ?? {}));
  console.log(`${name}/${subset} ${rf}: ${rows.length} disagreements`);
  for (const r of rows.sort()) console.log('  ' + r);
}

main();
