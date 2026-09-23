import { execFile } from 'node:child_process';
import type { StaticAnalysis, StaticAnalyzer } from '../../review/ports.js';

const SCRIPT = `
import ast, json, sys

payload = json.loads(sys.stdin.read())
out = {}
for path, source in payload.items():
    try:
        tree = ast.parse(source, path)
    except (SyntaxError, ValueError):
        continue
    findings = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        name = getattr(node, "name", "<lambda>")
        if name.startswith("__") and name.endswith("__"):
            continue
        body = node.body if isinstance(node.body, list) else [node.body]
        body = [item for item in body if not (
            isinstance(item, ast.Expr)
            and isinstance(item.value, ast.Constant)
            and isinstance(item.value.value, str)
        )]
        if not body or all(
            isinstance(item, ast.Pass)
            or (
                isinstance(item, ast.Expr)
                and isinstance(item.value, ast.Constant)
                and item.value.value is Ellipsis
            )
            for item in body
        ):
            continue
        arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
        if node.args.vararg:
            arguments.append(node.args.vararg)
        if node.args.kwarg:
            arguments.append(node.args.kwarg)
        used = {
            child.id
            for item in body
            for child in ast.walk(item)
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load)
        }
        for argument in arguments:
            if (
                argument.arg not in used
                and argument.arg not in {"self", "cls"}
                and not argument.arg.startswith("_")
            ):
                findings.append(f"{name}:{argument.arg}:L{argument.lineno}")
    out[path] = findings
print(json.dumps(out))
`;

interface PythonAnalyzerOptions {
  cwd: string;
  pythonPath?: string;
}

/**
 * SCRIPT を子プロセスで動かし、stdin に payload を流して stdout を返す。
 * -I (isolated mode) で cwd / PYTHONPATH / ユーザ site-packages を sys.path から外す。
 * レビュー対象リポジトリに ast.py などがあっても標準ライブラリが優先される。
 */
function runScript(pythonPath: string, cwd: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(pythonPath, ['-I', '-c', SCRIPT], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    const stdin = child.stdin;
    if (!stdin) {
      reject(new Error('python analyzer: child process has no stdin'));
      return;
    }
    // 子が入力を読み切る前に落ちると EPIPE になる。実際の失敗は execFile の
    // コールバック側で報告されるので、ここでは未処理 error イベントを防ぐだけ。
    stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EPIPE') reject(e);
    });
    stdin.end(payload);
  });
}

export function createPythonAnalyzer(options: PythonAnalyzerOptions): StaticAnalyzer {
  return {
    id: 'python',
    async analyze(files) {
      const selected = files.filter((file) => file.path.endsWith('.py'));
      if (selected.length === 0) return {};
      const payload = JSON.stringify(Object.fromEntries(selected.map((file) => [file.path, file.content])));
      const stdout = await runScript(options.pythonPath ?? 'python3', options.cwd, payload);
      const findings = JSON.parse(stdout) as Record<string, string[]>;
      return Object.fromEntries(
        Object.entries(findings).map(([path, unused]) => [
          path,
          {
            lint_unused_param: unused.length
              ? { verdict: 'NG', source: 'python', detail: unused.join(', ').slice(0, 300) }
              : { verdict: 'GOOD', source: 'python' },
          },
        ]),
      ) satisfies StaticAnalysis;
    },
  };
}
