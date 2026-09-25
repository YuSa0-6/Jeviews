// Jev を LLM の前段に置いたときの試算。Jev が「問題かもしれない」と見たファイルだけを LLM に回すと、
// 回す量がどれだけ減り、期待値の problem がどれだけ回した側に残るかを数える。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, evalDir, readJson } from './lib.mjs';

const LLM_GROUPS = new Set(['input_validation', 'error_handling', 'secret_exposure']);
const NOT_TOOL_SOURCES = new Set(['codex', 'human']);
const LOWS = [0.05, 0.1, 0.2, 0.35, 0.5];
const EDGES = [0, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 1.01];

function unsure(c, low) {
  if (!c.applicable) return false;
  if (c.reason === 'input_too_large' || c.reason === 'api_error') return true;
  if (!LLM_GROUPS.has(c.group)) return false;
  return c.verdict === 'NG' || c.reason === 'needs_context' || (c.problem?.probability ?? 0) > low;
}

export function escalates(file, low) {
  return file.checks.some((c) => unsure(c, low));
}

function llmProblems(file, truth) {
  return file.checks.filter((c) => c.applicable && LLM_GROUPS.has(c.group) && truth[c.checkId]?.truth === 'problem')
    .length;
}

export function cascade(expected, output, low) {
  const t = { files: 0, bytes: 0, problems: 0, sentFiles: 0, sentBytes: 0, keptProblems: 0 };
  for (const f of output.files) {
    const problems = llmProblems(f, expected.files[f.path] ?? {});
    t.files++;
    t.bytes += f.bytes;
    t.problems += problems;
    if (!escalates(f, low)) continue;
    t.sentFiles++;
    t.sentBytes += f.bytes;
    t.keptProblems += problems;
  }
  return t;
}

function emptyBins() {
  return EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: EDGES[i + 1], pairs: 0, problems: 0 }));
}

export function reliability(expected, output, bins = emptyBins()) {
  for (const f of output.files) {
    const truth = expected.files[f.path] ?? {};
    for (const c of f.checks) {
      if (!c.applicable || !LLM_GROUPS.has(c.group) || !c.problem) continue;
      const bin = bins.find((b) => c.problem.probability < b.hi);
      bin.pairs++;
      if (truth[c.checkId]?.truth === 'problem') bin.problems++;
    }
  }
  return bins;
}

function tally(t, problem, said) {
  if (problem) t[said ? 'tp' : 'fn']++;
  else if (said) t.fp++;
}

export function mechanical(expected, output, llmFindings) {
  const t = { jev: { tp: 0, fn: 0, fp: 0 }, llm: { tp: 0, fn: 0, fp: 0 } };
  for (const f of output.files) {
    const truth = expected.files[f.path] ?? {};
    for (const c of f.checks) {
      const tr = truth[c.checkId];
      if (!c.applicable || LLM_GROUPS.has(c.group) || !c.problem || !tr || NOT_TOOL_SOURCES.has(tr.source)) continue;
      tally(t.jev, tr.truth === 'problem', c.verdict === 'NG');
      tally(t.llm, tr.truth === 'problem', Boolean(llmFindings[f.path]?.[c.checkId]));
    }
  }
  return t;
}

function byVersion(a, b) {
  const [da, na] = a.split('.');
  const [db, nb] = b.split('.');
  return da.localeCompare(db) || Number(na) - Number(nb);
}

function latestRuns(dir, subset) {
  const files = readdirSync(dir).filter((f) => f.startsWith(`${subset}.`) && f.endsWith('.json'));
  const versionOf = (f) => f.slice(subset.length + 1).replace(/\.r\d+\.json$/, '');
  const latest = files.map(versionOf).sort(byVersion).at(-1);
  return { version: latest, files: files.filter((f) => versionOf(f) === latest).sort() };
}

function add(sum, part) {
  for (const [k, v] of Object.entries(part)) {
    if (typeof v === 'number') sum[k] = (sum[k] ?? 0) + v;
    else add((sum[k] ??= {}), v);
  }
  return sum;
}

const pct = (x, y) => (y ? `${((100 * x) / y).toFixed(1).padStart(5)}%` : '    - ');
const pad = (n, w = 4) => String(n).padStart(w);

function load(subset, names) {
  const runs = [];
  for (const name of names) {
    const expectedPath = join(evalDir(name), `${subset}.expected.json`);
    if (!existsSync(expectedPath)) continue;
    const expected = readJson(expectedPath);
    const llmFindings = readJson(join(evalDir(name), `${subset}.codex.json`), { findings: {} }).findings;
    const { version, files } = latestRuns(join(evalDir(name), 'results'), subset);
    for (const rf of files)
      runs.push({ name, version, expected, llmFindings, output: readJson(join(evalDir(name), 'results', rf)).output });
  }
  return runs;
}

function runLabel(runs) {
  const counts = {};
  for (const r of runs) counts[`${r.name} ${r.version}`] = (counts[`${r.name} ${r.version}`] ?? 0) + 1;
  return Object.entries(counts)
    .map(([k, n]) => `${k} x${n}`)
    .join(', ');
}

function printCascade(runs) {
  console.log('   low   LLM files   LLM bytes   problems kept');
  for (const low of LOWS) {
    const t = runs.reduce((s, r) => add(s, cascade(r.expected, r.output, low)), {});
    console.log(
      `  ${low.toFixed(2)}  ${pct(t.sentFiles, t.files)}      ${pct(t.sentBytes, t.bytes)}      ${pct(t.keptProblems, t.problems)} (${t.keptProblems}/${t.problems})`,
    );
  }
}

function printReliability(runs) {
  const bins = emptyBins();
  for (const r of runs) reliability(r.expected, r.output, bins);
  console.log('\n  Jev の problem 確率ごとに、期待値が problem だった割合 (input / error / secret)');
  for (const b of bins)
    console.log(
      `  ${b.lo.toFixed(2)}-${Math.min(b.hi, 1).toFixed(2)}  pairs=${pad(b.pairs, 5)}  problem=${pad(b.problems)}  ${pct(b.problems, b.pairs)}`,
    );
}

function printMechanical(runs) {
  const m = runs.reduce((s, r) => add(s, mechanical(r.expected, r.output, r.llmFindings)), {});
  console.log('\n  道具の正解がある機械的な観点で、Jev と LLM (codex.json) を採点する');
  for (const [who, t] of Object.entries(m)) console.log(`  ${who}  tp=${pad(t.tp)}  fn=${pad(t.fn)}  fp=${pad(t.fp)}`);
}

function print(subset, runs) {
  console.log(`\n== cascade ${subset}: ${runLabel(runs)}`);
  console.log(
    '  LLM に回す: input / error / secret の観点で problem > low・NG・needs_context、または Jev の判定が欠けている',
  );
  printCascade(runs);
  printReliability(runs);
  printMechanical(runs);
}

function main() {
  const [subset, ...names] = process.argv.slice(2);
  if (!subset) throw new Error('usage: cascade.mjs <subset> [repo...]');
  const runs = load(subset, names.length ? names : Object.keys(config.repos));
  if (runs.length === 0) throw new Error(`no results for subset ${subset}`);
  print(subset, runs);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main();
