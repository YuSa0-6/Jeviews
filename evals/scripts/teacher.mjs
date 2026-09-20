// linter / formatter の結果を Jeviews の観点ごとの正解 (problem / clean) に写す。
// 粒度は「そのファイルにその観点の指摘が 1 つ以上あるか」。写せない観点は書かない (unknown)。
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, evalDir, readJson, repoDir, run, workDir, writeJson } from './lib.mjs';

const [name, subset] = process.argv.slice(2);
if (!name || !subset) throw new Error('usage: teacher.mjs <repo> <subset>');
const r = config.repos[name];
const wd = workDir(name, subset);
const files = readFileSync(join(evalDir(name), `${subset}.files.txt`), 'utf8').trim().split('\n');
const truth = Object.fromEntries(files.map((f) => [f, {}]));
const tools = {};
const relPath = (file) => file.replace(wd + '/', '').replace(/^\.\//, '');
const set = (file, check, value, source, detail) => {
  const entry = truth[relPath(file)] ?? {};
  if (entry[check]?.truth === 'problem') return;
  entry[check] = { truth: value, source, detail };
};
const markAll = (check, value, source, only = files) => { for (const f of only) if (!truth[f][check]) set(f, check, value, source); };
const FORMAT = ['format_indentation', 'format_quotes', 'format_spacing'];
const LINT_UNUSED = ['lint_unused_import', 'lint_unused_variable', 'lint_unused_param'];

if (r.language === 'typescript') {
  const tsFiles = files.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
  const tsc = run('npx', ['-y', '-p', 'typescript@7', 'tsc', '--noEmit', '--ignoreConfig', '--allowJs', '--jsx', 'preserve', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', '--noUnusedLocals', '--noUnusedParameters', '--types', '', ...tsFiles], { cwd: wd });
  if (/TS5112/.test(tsc.out) || (tsc.code !== 0 && !/TS\d{4}/.test(tsc.out))) throw new Error('tsc did not run: ' + (tsc.err || tsc.out).slice(0, 300));
  tools.tsc = { code: tsc.code, diagnostics: (tsc.out.match(/error TS61(33|92|98)/g) ?? []).length };
  markAll('lint_unused_import', 'clean', 'tsc', tsFiles); markAll('lint_unused_variable', 'clean', 'tsc', tsFiles); markAll('lint_unused_param', 'clean', 'tsc', tsFiles);
  for (const m of tsc.out.matchAll(/^(.+?)\((\d+),(\d+)\): error TS(6133|6192|6198)(.*)$/gm)) {
    const [, file, line, , code, rest] = m;
    const src = readFileSync(join(wd, file), 'utf8').split('\n')[Number(line) - 1] ?? '';
    const ident = (rest.match(/'([^']+)'/) ?? [])[1] ?? '';
    let check = 'lint_unused_variable';
    if (code === '6192' || /^\s*import\b/.test(src)) check = 'lint_unused_import';
    else if (!/^\s*(const|let|var)\b/.test(src) && new RegExp(`[(,]\\s*(\\.\\.\\.)?${ident.replace(/[$]/g, '\\$')}\\b`).test(src)) check = 'lint_unused_param';
    set(file, check, 'problem', 'tsc', `TS${code} ${ident} L${line}`);
  }
  for (const c of ['.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.cjs', 'prettier.config.js', '.prettierignore']) {
    const src = join(repoDir(name), c); if (existsSync(src)) copyFileSync(src, join(wd, c));
  }
  const fh = run('npx', ['-y', 'fallow', 'health', '--format', 'json'], { cwd: wd });
  const health = JSON.parse(fh.out || '{"findings":[]}');
  const maxCyc = {};
  for (const d of health.findings) maxCyc[d.path] = Math.max(maxCyc[d.path] ?? 0, d.cyclomatic ?? 0);
  tools.fallow = { code: fh.code, findings: health.findings.length };
  for (const f of tsFiles) {
    const m = maxCyc[f] ?? 0;
    if (m >= 15) set(f, 'complexity_branchy_function', 'problem', 'fallow', `max cyclomatic ${m}`);
    else if (m <= 8) set(f, 'complexity_branchy_function', 'clean', 'fallow');
  }
  const pr = run('npx', ['-y', 'prettier@3', '--check', ...tsFiles], { cwd: wd });
  const bad = new Set([...pr.err.matchAll(/^\[warn\] (.+)$/gm)].map((m) => m[1]).filter((f) => truth[f]));
  tools.prettier = { code: pr.code, unformatted: bad.size };
  for (const f of files) if (!bad.has(f)) for (const c of FORMAT) set(f, c, 'clean', 'prettier');
}

if (r.language === 'ruby') {
  const COPS = {
    'Lint/UnusedMethodArgument': 'lint_unused_param', 'Lint/UnusedBlockArgument': 'lint_unused_param',
    'Lint/UselessAssignment': 'lint_unused_variable', 'Lint/SuppressedException': 'error_empty_catch',
    'Lint/LiteralAsCondition': 'lint_constant_condition', 'Lint/UnreachableCode': 'lint_unreachable',
    'Layout/IndentationWidth': 'format_indentation', 'Layout/IndentationConsistency': 'format_indentation', 'Layout/IndentationStyle': 'format_indentation',
    'Layout/SpaceAroundOperators': 'format_spacing', 'Layout/SpaceAfterComma': 'format_spacing', 'Layout/SpaceInsideBlockBraces': 'format_spacing', 'Layout/SpaceAroundKeyword': 'format_spacing', 'Layout/SpaceInsideParens': 'format_spacing',
    'Style/StringLiterals': 'format_quotes',
  };
  writeFileSync(join(wd, '.rubocop.yml'), 'AllCops:\n  TargetRubyVersion: 3.3\n  SuggestExtensions: false\n');
  const rb = run('rubocop', ['--config', '.rubocop.yml', '--cache', 'false', '--format', 'json', '--only', Object.keys(COPS).join(','), ...files], { cwd: wd });
  const j = JSON.parse(rb.out || '{"files":[]}');
  tools.rubocop = { code: rb.code, inspected: j.files.length, offenses: j.files.reduce((n, f) => n + f.offenses.length, 0) };
  if (j.files.length !== files.length) throw new Error(`rubocop inspected ${j.files.length}/${files.length}: ${rb.err.slice(0, 300)}`);
  const broken = new Set(j.files.filter((f) => f.offenses.some((o) => o.cop_name === 'Lint/Syntax')).map((f) => f.path));
  tools.rubocop.syntaxErrors = broken.size;
  for (const f of j.files) {
    if (broken.has(f.path)) continue;
    for (const o of f.offenses) {
      const check = COPS[o.cop_name]; if (!check) continue;
      if (check === 'format_quotes') {
        const src = readFileSync(join(wd, f.path), 'utf8');
        if (!(/'[^'\n]*'/.test(src) && /"[^"\n]*"/.test(src))) continue;
      }
      set(f.path, check, 'problem', 'rubocop', `${o.cop_name} L${o.location.line}`); seen.add(f.path + check);
    }
  }
  for (const c of [...new Set(Object.values(COPS))].filter((c) => c !== 'error_empty_catch')) markAll(c, 'clean', 'rubocop', files.filter((f) => !broken.has(f)));
}

if (r.language === 'python') {
  const RULES = { F401: 'lint_unused_import', F841: 'lint_unused_variable', ARG001: 'lint_unused_param', ARG002: 'lint_unused_param', ARG004: 'lint_unused_param', S110: 'error_empty_catch', E101: 'format_indentation', W191: 'format_indentation' };
  const uv = ['exec', 'uv@latest', '--', 'uvx', 'ruff'];
  const ck = run('mise', [...uv, 'check', '--isolated', '--no-cache', '--output-format', 'json', '--select', Object.keys(RULES).join(','), ...files], { cwd: wd });
  if (![0, 1].includes(ck.code)) throw new Error('ruff check failed: ' + ck.err.slice(0, 300));
  const diags = JSON.parse(ck.out || '[]');
  tools.ruff = { code: ck.code, diagnostics: diags.length };
  for (const d of diags) {
    const check = RULES[d.code]; if (!check) continue;
    set(d.filename, check, 'problem', 'ruff', `${d.code} L${d.location.row}`);
  }
  for (const c of [...new Set(Object.values(RULES))].filter((c) => c !== 'error_empty_catch')) markAll(c, 'clean', 'ruff');
  const fm = run('mise', [...uv, 'format', '--check', '--isolated', '--no-cache', ...files], { cwd: wd });
  if (![0, 1].includes(fm.code)) throw new Error('ruff format failed: ' + fm.err.slice(0, 300));
  const bad = new Set([...fm.out.matchAll(/^Would reformat: (.+)$/gm)].map((m) => m[1]));
  tools.ruffFormat = { code: fm.code, wouldReformat: bad.size };
  for (const f of files) if (!bad.has(f)) for (const c of FORMAT) set(f, c, 'clean', 'ruff-format');
}

if (r.language === 'go') {
  const goFiles = files.filter((f) => f.endsWith('.go'));
  const fmt = run('mise', ['exec', 'go@latest', '--', 'gofmt', '-l', ...goFiles], { cwd: wd });
  if (fmt.code !== 0) throw new Error('gofmt failed: ' + fmt.err.slice(0, 300));
  const bad = new Set(fmt.out.split('\n').filter(Boolean));
  tools.gofmt = { unformatted: bad.size };
  for (const f of goFiles) if (!bad.has(f)) for (const c of FORMAT) set(f, c, 'clean', 'gofmt');
  const build = run('mise', ['exec', 'go@latest', '--', 'go', 'vet', './...'], { cwd: repoDir(name) });
  tools.goVet = { code: build.code };
  if (build.code === 0) { markAll('lint_unused_import', 'clean', 'go-compiler', goFiles); markAll('lint_unused_variable', 'clean', 'go-compiler', goFiles); }
  else console.error('go vet failed in clone; skipping compiler negatives:', build.err.slice(0, 300));
  const sc = run('mise', ['exec', 'go@latest', '--', 'go', 'run', 'honnef.co/go/tools/cmd/staticcheck@latest', '-f', 'json', './...'], { cwd: repoDir(name) });
  tools.staticcheck = { code: sc.code, lines: sc.out.split('\n').filter(Boolean).length, err: sc.err.slice(0, 200) };
  for (const line of sc.out.split('\n').filter(Boolean)) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    const rel = d.location.file.replace(repoDir(name) + '/', '');
    if (d.code === 'SA4006' || d.code === 'SA4009') set(rel, 'lint_unused_variable', 'problem', 'staticcheck', `${d.code} L${d.location.line}`);
    if (d.code === 'SA9003') set(rel, 'error_empty_catch', 'problem', 'staticcheck', `${d.code} L${d.location.line}`);
    if (d.code === 'SA4004') set(rel, 'lint_constant_condition', 'problem', 'staticcheck', `${d.code} L${d.location.line}`);
  }
}

const codex = readJson(join(evalDir(name), `${subset}.codex.json`), { findings: {} }).findings;
for (const [f, checks] of Object.entries(codex)) for (const [c, v] of Object.entries(checks)) if (truth[f] && truth[f][c]?.truth !== 'problem') truth[f][c] = v;

const human = readJson(join(evalDir(name), `${subset}.human.json`), {});
for (const [f, checks] of Object.entries(human)) for (const [c, v] of Object.entries(checks)) if (truth[f]) truth[f][c] = { ...v, source: v.source ?? 'human' };

const out = { repo: name, subset, pin: r.pin ?? null, tools, files: truth };
writeJson(join(evalDir(name), `${subset}.expected.json`), out);
const counts = {};
for (const checks of Object.values(truth)) for (const [c, v] of Object.entries(checks)) { counts[c] ??= { problem: 0, clean: 0 }; counts[c][v.truth]++; }
console.log(`${name}/${subset}: ${files.length} files  tools=${JSON.stringify(tools)}`);
for (const [c, v] of Object.entries(counts).sort()) console.log(`  ${c.padEnd(26)} problem=${String(v.problem).padStart(3)} clean=${String(v.clean).padStart(3)}`);
