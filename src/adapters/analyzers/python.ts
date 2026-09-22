import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { StaticAnalysis, StaticAnalyzer } from '../../review/ports.js';

const execFileAsync = promisify(execFile);
const SCRIPT = `
import ast, json, pathlib, sys

out = {}
for path in sys.argv[1:]:
    try:
        tree = ast.parse(pathlib.Path(path).read_text(), path)
    except (OSError, SyntaxError, UnicodeDecodeError):
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

export function createPythonAnalyzer(options: PythonAnalyzerOptions): StaticAnalyzer {
  return {
    id: 'python',
    async analyze(files) {
      const selected = files.filter((file) => file.path.endsWith('.py'));
      if (selected.length === 0) return {};
      const { stdout } = await execFileAsync(
        options.pythonPath ?? 'python3',
        ['-c', SCRIPT, ...selected.map((file) => file.path)],
        { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 },
      );
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
