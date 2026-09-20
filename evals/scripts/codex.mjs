// codex exec のレビュー出力 (<path> | <checkId> | <line> | <evidence>) を、観点ごとの正解 (problem のみ) に写す。
// レビューは網羅的ではないので、書かれていないものを clean とは扱わない。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalDir, writeJson } from './lib.mjs';

const KNOWN = new Set([
  'input_unchecked_use', 'input_missing_unhandled', 'error_empty_catch', 'error_success_after_failure', 'error_unhandled_promise',
  'secret_hardcoded', 'secret_logged', 'format_indentation', 'format_quotes', 'format_spacing',
  'lint_unused_import', 'lint_unused_variable', 'lint_unused_param', 'lint_unreachable', 'lint_duplicate_condition',
  'lint_constant_condition', 'complexity_branchy_function',
]);

function parseLine(line) {
  const parts = line.split('|').map((s) => s.trim());
  if (parts.length < 3 || !KNOWN.has(parts[1])) return null;
  return { file: parts[0].replace(/^\.\//, ''), checkId: parts[1], line: parts[2], evidence: parts.slice(3).join(' | ') };
}

function collect(lines, files) {
  const out = {};
  const findings = lines.map(parseLine).filter((p) => p && files.has(p.file));
  for (const p of findings) {
    const entry = (out[p.file] ??= {});
    entry[p.checkId] ??= { truth: 'problem', source: 'codex', detail: `L${p.line} ${p.evidence}`.slice(0, 200) };
  }
  return { out, skipped: lines.filter((l) => l.trim()).length - findings.length };
}

function main() {
  const [name, subset, textFile] = process.argv.slice(2);
  if (!name || !subset || !textFile) throw new Error('usage: codex.mjs <repo> <subset> <codex output file>');
  const files = new Set(readFileSync(join(evalDir(name), `${subset}.files.txt`), 'utf8').trim().split('\n'));
  const { out, skipped } = collect(readFileSync(textFile, 'utf8').split('\n'), files);
  const target = join(evalDir(name), `${subset}.codex.json`);
  writeJson(target, { repo: name, subset, model: 'gpt-6-astra', findings: out });
  const n = Object.values(out).reduce((s, e) => s + Object.keys(e).length, 0);
  console.log(`${name}/${subset}: ${n} findings in ${Object.keys(out).length} files (${skipped} lines skipped) -> ${target}`);
}

main();
