// scan 結果を expected と突き合わせ、観点ごとの precision / recall とファイル判定の一致率を出す。
import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EVALS, evalDir, JEVIEWS, readJson } from './lib.mjs';

function abstained(c) {
  return c.verdict === null || (c.verdict === 'NEED_REVIEW' && c.reason !== 'uncertain');
}

function bump(per, checkId) {
  return (per[checkId] ??= { tp: 0, fp: 0, fn: 0, tn: 0, abstain: 0 });
}

function outcome(truth, said) {
  if (truth === 'problem') return said ? 'tp' : 'fn';
  return said ? 'fp' : 'tn';
}

function scoreCheck(c, t, per, st) {
  st.covered++;
  if (t === 'problem') st.expProblem = true;
  if (abstained(c)) {
    st.abstain = true;
    st.allKnown = false;
    bump(per, c.checkId).abstain++;
    return;
  }
  const said = c.verdict === 'NG';
  if (said) st.saidNG = true;
  bump(per, c.checkId)[outcome(t, said)]++;
}

function scoreFile(f, truth, per) {
  const st = { expProblem: false, allKnown: true, anyApplicable: false, covered: 0, saidNG: false, abstain: false };
  for (const c of f.checks.filter((c) => c.applicable)) {
    st.anyApplicable = true;
    const t = truth[c.checkId]?.truth;
    if (t) scoreCheck(c, t, per, st);
    else st.allKnown = false;
  }
  return st;
}

function expectedVerdict(st) {
  if (!st.anyApplicable) return null;
  if (st.expProblem) return 'NG';
  return st.allKnown ? 'GOOD' : null;
}

function countKnown(tot, st, verdict) {
  const want = expectedVerdict(st);
  if (!want) return;
  tot.known++;
  if (verdict === want) tot.agree++;
}

function countCovered(tot, st) {
  if (st.covered === 0 || st.abstain) return;
  tot.covered++;
  if (st.expProblem === st.saidNG) tot.coveredOk++;
}

function div(x, y) {
  return y ? x / y : null;
}

function rates(p) {
  return {
    ...p,
    precision: div(p.tp, p.tp + p.fp),
    recall: div(p.tp, p.tp + p.fn),
    accuracy: div(p.tp + p.tn, p.tp + p.fp + p.fn + p.tn),
  };
}

export function score(expected, output) {
  const per = {};
  const tot = { known: 0, agree: 0, covered: 0, coveredOk: 0 };
  for (const f of output.files) {
    const st = scoreFile(f, expected.files[f.path] ?? {}, per);
    countKnown(tot, st, f.verdict);
    countCovered(tot, st);
  }
  const files = output.files.length;
  const needReview = output.files.filter((f) => f.verdict === 'NEED_REVIEW').length;
  const checks = Object.fromEntries(Object.entries(per).map(([k, p]) => [k, rates(p)]));
  return {
    files,
    ...tot,
    fileAccuracy: div(tot.agree, tot.known),
    coveredAccuracy: div(tot.coveredOk, tot.covered),
    needReviewRate: div(needReview, files),
    checks,
  };
}

const fmt = (x) => (x === null || x === undefined ? '  -  ' : (x * 100).toFixed(0).padStart(4) + '%');
const pad = (n, w = 3) => String(n).padStart(w);

function resultFiles(dir, subset, which) {
  const all = readdirSync(dir)
    .filter((f) => f.startsWith(`${subset}.`) && f.endsWith('.json'))
    .sort();
  if (which === 'latest') return all.slice(-1);
  return which === 'all' ? all : [which];
}

function print(name, subset, meta, output, s) {
  console.log(
    `\n== ${name}/${subset} ${meta.questionVersion} r${meta.run} (${meta.jeviewsCommit})  files=${s.files} covered=${s.covered} coveredAccuracy=${fmt(s.coveredAccuracy)} known=${s.known} fileAccuracy=${fmt(s.fileAccuracy)} needReview=${fmt(s.needReviewRate)} usd=${output.run.usage.costUsd}`,
  );
  console.log('  check                      tp  fp  fn  tn abst  prec  rec   acc');
  for (const [k, p] of Object.entries(s.checks).sort())
    console.log(
      `  ${k.padEnd(26)} ${pad(p.tp)} ${pad(p.fp)} ${pad(p.fn)} ${pad(p.tn)} ${pad(p.abstain, 4)} ${fmt(p.precision)} ${fmt(p.recall)} ${fmt(p.accuracy)}`,
    );
}

function record(name, subset, meta, rf, output, s) {
  const checks = Object.fromEntries(
    Object.entries(s.checks).map(([k, p]) => [k, { tp: p.tp, fp: p.fp, fn: p.fn, tn: p.tn, abstain: p.abstain }]),
  );
  const row = {
    repo: name,
    subset,
    ...meta,
    resultFile: rf,
    costUsd: output.run.usage.costUsd,
    files: s.files,
    covered: s.covered,
    coveredAccuracy: s.coveredAccuracy,
    known: s.known,
    fileAccuracy: s.fileAccuracy,
    needReviewRate: s.needReviewRate,
    checks,
  };
  appendFileSync(join(EVALS, 'history.jsonl'), JSON.stringify(row) + '\n');
}

function parseArgs(argv) {
  const [name, subset, which = 'latest', mode = 'record'] = argv;
  if (!name || !subset) throw new Error('usage: score.mjs <repo> <subset> [latest|all|<file>] [record|dry]');
  return { name, subset, which, mode };
}

function loadExpected(name, subset) {
  const expected = readJson(join(evalDir(name), `${subset}.expected.json`), null);
  if (!expected) throw new Error('no expected.json; run teacher.mjs first');
  return expected;
}

function main() {
  const { name, subset, which, mode } = parseArgs(process.argv.slice(2));
  const dir = join(evalDir(name), 'results');
  const expected = loadExpected(name, subset);
  for (const rf of resultFiles(dir, subset, which)) {
    const { meta, output } = readJson(join(dir, rf));
    const s = score(expected, output);
    print(name, subset, meta, output, s);
    if (mode === 'record') record(name, subset, meta, rf, output, s);
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main();
