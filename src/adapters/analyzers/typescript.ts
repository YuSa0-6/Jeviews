import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { StaticAnalysis, StaticAnalyzer, StaticCheckResult, TrackedFile } from '../../review/ports.js';

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
      const [{ code, output }, complexity] = await Promise.all([
        runTsc(
          tscPath,
          options.cwd,
          selected.map((file) => file.path),
        ),
        complexityResults(options.cwd, selected),
      ]);
      if (/TS5112/.test(output) || (code !== 0 && !/TS\d{4}/.test(output))) {
        throw new Error(`tsc did not run: ${output.slice(0, 300)}`);
      }
      const analysis = diagnostics(selected, output, options.cwd);
      for (const [path, result] of Object.entries(complexity)) {
        const entry = analysis[path];
        if (entry) entry.complexity_branchy_function = result;
      }
      return analysis;
    },
  };
}

function bundledTscPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

function bundledFallowPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('fallow/package.json')), 'bin', 'fallow');
}

async function complexityResults(
  cwd: string,
  files: readonly TrackedFile[],
): Promise<Record<string, StaticCheckResult>> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        bundledFallowPath(),
        'health',
        '--complexity',
        '--max-cyclomatic',
        '8',
        '--max-cognitive',
        '9999',
        '--max-crap',
        '999999',
        '--format',
        'json',
        '--report-only',
        '--quiet',
        '--no-cache',
        '--no-production',
      ],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    );
    const report = JSON.parse(stdout) as {
      findings?: { path?: string; cyclomatic?: number }[];
      workspace_diagnostics?: { path?: string; degrades_analysis?: boolean }[];
    };
    const maximum = new Map<string, number>();
    for (const finding of report.findings ?? []) {
      if (finding.path === undefined || finding.cyclomatic === undefined) continue;
      const path = normalizePath(finding.path, cwd);
      maximum.set(path, Math.max(maximum.get(path) ?? 0, finding.cyclomatic));
    }
    const degraded = new Set(
      (report.workspace_diagnostics ?? [])
        .filter((diagnostic) => diagnostic.degrades_analysis && diagnostic.path && diagnostic.path !== '.')
        .map((diagnostic) => normalizePath(diagnostic.path as string, cwd)),
    );
    return Object.fromEntries(
      files.flatMap((file) => {
        if (degraded.has(file.path)) return [];
        const cyclomatic = maximum.get(file.path) ?? 0;
        if (cyclomatic > 8 && cyclomatic < 15) return [];
        return [
          [
            file.path,
            cyclomatic >= 15
              ? { verdict: 'NG', source: 'fallow', detail: `max cyclomatic ${cyclomatic}` }
              : { verdict: 'GOOD', source: 'fallow' },
          ],
        ];
      }),
    );
  } catch {
    return {};
  }
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
