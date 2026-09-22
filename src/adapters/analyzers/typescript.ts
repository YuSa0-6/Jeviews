import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { StaticAnalysis, StaticAnalyzer, TrackedFile } from '../../review/ports.js';

const execFileAsync = promisify(execFile);
const TYPESCRIPT_FILE = /\.(?:[cm]?[tj]sx?)$/;
const CHECKS = ['lint_unused_import', 'lint_unused_variable', 'lint_unused_param'] as const;
const UNUSED_DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error TS(6133|6192|6198)(.*)$/gm;

interface TypeScriptAnalyzerOptions {
  cwd: string;
  tscPath?: string;
}

export function createTypeScriptAnalyzer(options: TypeScriptAnalyzerOptions): StaticAnalyzer {
  return {
    id: 'typescript',
    async analyze(files) {
      const selected = files.filter((file) => TYPESCRIPT_FILE.test(file.path));
      if (selected.length === 0) return {};
      const tscPath = options.tscPath ?? bundledTscPath();
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
}

function bundledTscPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

async function runTsc(tscPath: string, cwd: string, files: string[]): Promise<{ code: number; output: string }> {
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
    ...files,
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
  const analysis: StaticAnalysis = Object.fromEntries(
    files.map((file) => [
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
  const sourceLine = file.content.split('\n')[diagnostic.line - 1] ?? '';
  const checkId = diagnosticCheck(diagnostic.code, sourceLine, diagnostic.identifier);
  entry[checkId] = {
    verdict: 'NG',
    source: 'typescript',
    detail: `TS${diagnostic.code} ${diagnostic.identifier} L${diagnostic.line}`.trim(),
  };
}

function normalizePath(path: string, cwd: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized.startsWith('/') ? relative(cwd, normalized).replaceAll('\\', '/') : normalized;
}

function diagnosticCheck(code: string, sourceLine: string, identifier: string): (typeof CHECKS)[number] {
  if (code === '6192' || /^\s*import\b/.test(sourceLine)) return 'lint_unused_import';
  if (
    !/^\s*(const|let|var)\b/.test(sourceLine) &&
    new RegExp(`[(,]\\s*(\\.\\.\\.)?${identifier.replace(/[$]/g, '\\$')}\\b`).test(sourceLine)
  ) {
    return 'lint_unused_param';
  }
  return 'lint_unused_variable';
}
