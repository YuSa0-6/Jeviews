import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { StaticAnalysis, StaticAnalyzer, TrackedFile } from '../../review/ports.js';

const execFileAsync = promisify(execFile);
const TYPESCRIPT_FILE = /\.(?:[cm]?[tj]sx?)$/;
const CHECKS = ['lint_unused_import', 'lint_unused_variable', 'lint_unused_param'] as const;
const UNUSED_DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error TS(6133|6192|6198)(.*)$/gm;
/** TS1xxx は構文エラー。そのファイルでは未使用解析が走らないので結果を出さない。 */
const SYNTAX_DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error TS1\d{3}\b/gm;
const DECLARATION_START = /^\s*(const|let|var)\b/;

interface TypeScriptAnalyzerOptions {
  cwd: string;
  tscPath?: string;
}

export function createTypeScriptAnalyzer(options: TypeScriptAnalyzerOptions): StaticAnalyzer {
  const analyzer: StaticAnalyzer = {
    id: 'typescript',
    async analyze(files) {
      const selected = files.filter((file) => TYPESCRIPT_FILE.test(file.path));
      if (selected.length === 0) return {};
      const tscPath = options.tscPath ?? packageBin('typescript', 'tsc');
      const { code, output } = await runTsc(
        tscPath,
        options.cwd,
        selected.map((file) => file.path),
      );
      if (/TS5112/.test(output) || (code !== 0 && !/TS\d{4}/.test(output))) {
        throw new Error(`tsc did not run: ${output.slice(0, 300)}`);
      }
      return diagnostics(selected, output, options.cwd);
    },
  };
  // tsc を差し替えたときは同梱版の番号が当てにならないので、版を名乗らない。
  const version = options.tscPath === undefined ? packageVersion('typescript') : undefined;
  if (version !== undefined) analyzer.version = `tsc@${version}`;
  return analyzer;
}

/** パッケージの bin フィールドから実行ファイルのパスを引く。配置が変わっても追従できる。 */
function packageBin(pkg: string, name: string): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve(`${pkg}/package.json`);
  const { bin } = require(manifestPath) as { bin?: string | Record<string, string> };
  const entry = typeof bin === 'string' ? bin : bin?.[name];
  if (entry === undefined) throw new Error(`${pkg} の package.json に bin.${name} がありません`);
  return join(dirname(manifestPath), entry);
}

/** 同梱パッケージの版。入っていなければ undefined (解析器はその場合 provider に戻る)。 */
function packageVersion(pkg: string): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return (require(`${pkg}/package.json`) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** ファイル一覧は argv ではなくレスポンスファイルで渡す。argv だと大きな repo で E2BIG になる。 */
async function runTsc(tscPath: string, cwd: string, files: string[]): Promise<{ code: number; output: string }> {
  const listFile = join(tmpdir(), `jeview-tsc-${randomUUID()}.txt`);
  await writeFile(listFile, `${files.map((file) => JSON.stringify(file)).join('\n')}\n`);
  try {
    return await runTscWithList(tscPath, cwd, listFile);
  } finally {
    await rm(listFile, { force: true });
  }
}

async function runTscWithList(
  tscPath: string,
  cwd: string,
  listFile: string,
): Promise<{ code: number; output: string }> {
  const args = [
    tscPath,
    '--noEmit',
    '--ignoreConfig',
    '--allowJs',
    '--jsx',
    'preserve',
    '--target',
    'es2022',
    '--module',
    'esnext',
    '--moduleResolution',
    'bundler',
    '--skipLibCheck',
    '--noUnusedLocals',
    '--noUnusedParameters',
    '--types',
    '',
    `@${listFile}`,
  ];
  try {
    const result = await execFileAsync(process.execPath, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const failed = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    if (typeof failed.code !== 'number') throw error;
    return { code: failed.code, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

function diagnostics(files: readonly TrackedFile[], output: string, cwd: string): StaticAnalysis {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const broken = syntaxErrorPaths(output, cwd);
  const analysis: StaticAnalysis = Object.fromEntries(
    files
      .filter((file) => !broken.has(file.path))
      .map((file) => [
        file.path,
        Object.fromEntries(CHECKS.map((checkId) => [checkId, { verdict: 'GOOD', source: 'typescript' }])),
      ]),
  );
  for (const diagnostic of parseDiagnostics(output, cwd)) {
    const file = byPath.get(diagnostic.path);
    const entry = analysis[diagnostic.path];
    if (file && entry) applyDiagnostic(entry, file, diagnostic);
  }
  return analysis;
}

interface UnusedDiagnostic {
  path: string;
  line: number;
  code: string;
  identifier: string;
}

/** 構文エラーが出たファイル。tsc は構文エラーのあるファイルで未使用解析を走らせないため GOOD の根拠がない。 */
function syntaxErrorPaths(output: string, cwd: string): Set<string> {
  const paths = new Set<string>();
  for (const match of output.matchAll(SYNTAX_DIAGNOSTIC)) {
    const rawPath = match[1];
    if (rawPath !== undefined) paths.add(normalizePath(rawPath, cwd));
  }
  return paths;
}

function parseDiagnostics(output: string, cwd: string): UnusedDiagnostic[] {
  return [...output.matchAll(UNUSED_DIAGNOSTIC)].flatMap((match) => {
    const [, rawPath, rawLine, , code, rest] = match;
    if (rawPath === undefined || rawLine === undefined || code === undefined || rest === undefined) return [];
    return [
      {
        path: normalizePath(rawPath, cwd),
        line: Number(rawLine),
        code,
        identifier: rest.match(/'([^']+)'/)?.[1] ?? '',
      },
    ];
  });
}

function applyDiagnostic(
  entry: Record<string, { verdict: 'GOOD' | 'NG'; source: string; detail?: string }>,
  file: TrackedFile,
  diagnostic: UnusedDiagnostic,
): void {
  const lines = file.content.split('\n');
  const sourceLine = lines[diagnostic.line - 1] ?? '';
  const previousLine = previousSourceLine(lines, diagnostic.line);
  const checkId = diagnosticCheck(diagnostic.code, sourceLine, previousLine, diagnostic.identifier);
  entry[checkId] = {
    verdict: 'NG',
    source: 'typescript',
    detail: `TS${diagnostic.code} ${diagnostic.identifier} L${diagnostic.line}`.trim(),
  };
}

/** 診断のパスを cwd からの相対パスにそろえる。絶対パスの判定は実行環境の規則に任せる (Windows なら C:\\... も絶対)。 */
export function normalizePath(path: string, cwd: string): string {
  const relativePath = isAbsolute(path) ? relative(cwd, path) : path;
  return relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** 直前の非空行。引数リストを複数行に分けた `function f(` のような行を拾う。 */
function previousSourceLine(lines: readonly string[], line: number): string {
  for (let index = line - 2; index >= 0; index -= 1) {
    const candidate = lines[index] ?? '';
    if (candidate.trim() !== '') return candidate;
  }
  return '';
}

function diagnosticCheck(
  code: string,
  sourceLine: string,
  previousLine: string,
  identifier: string,
): (typeof CHECKS)[number] {
  if (code === '6192' || /^\s*import\b/.test(sourceLine)) return 'lint_unused_import';
  // 変数宣言の guard は行ごとに見る。`const {` の続きの行を引数と取り違えないため。
  if (DECLARATION_START.test(sourceLine) || DECLARATION_START.test(previousLine)) return 'lint_unused_variable';
  const context = `${previousLine}${sourceLine}`;
  if (new RegExp(`[(,{]\\s*(\\.\\.\\.)?${identifier.replace(/[$]/g, '\\$')}\\b`).test(context)) {
    return 'lint_unused_param';
  }
  return 'lint_unused_variable';
}
