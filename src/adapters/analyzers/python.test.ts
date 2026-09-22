import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createPythonAnalyzer } from './python.js';

const dirs: string[] = [];

function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'jeview-python-'));
  dirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('python analyzer', () => {
  test('finds unused parameters without flagging protocol or stub signatures', async () => {
    const cwd = makeCwd();
    const sources = {
      'bad.py': 'def callback(value, unused):\n    return value\n',
      'good.py': 'def callback(value):\n    return value\n',
      'protocol.py': 'def __deepcopy__(self, memo):\n    return self\n',
      'stub.py': 'def callback(required):\n    pass\n',
    };

    const files = Object.entries(sources).map(([path, content]) => ({
      path,
      content,
      bytes: Buffer.byteLength(content),
      revision: 'test',
    }));
    const result = await createPythonAnalyzer({ cwd }).analyze(files);

    expect(result['bad.py']?.lint_unused_param).toMatchObject({ verdict: 'NG', source: 'python' });
    expect(result['bad.py']?.lint_unused_param.detail).toContain('callback:unused:L1');
    for (const path of ['good.py', 'protocol.py', 'stub.py']) {
      expect(result[path]?.lint_unused_param).toEqual({ verdict: 'GOOD', source: 'python' });
    }
  });

  test('ignores modules in the reviewed repository that shadow the standard library', async () => {
    const cwd = makeCwd();
    // cwd が sys.path に入ると、これらが標準ライブラリより先に import される。
    for (const name of ['ast.py', 'json.py', 'sys.py']) {
      writeFileSync(join(cwd, name), `raise SystemExit("hijacked: ${name}")\n`);
    }
    const content = 'def callback(value, unused):\n    return value\n';

    const result = await createPythonAnalyzer({ cwd }).analyze([
      { path: 'bad.py', content, bytes: Buffer.byteLength(content), revision: 'test' },
    ]);

    expect(result['bad.py']?.lint_unused_param).toMatchObject({ verdict: 'NG', source: 'python' });
    expect(result['bad.py']?.lint_unused_param.detail).toContain('callback:unused:L1');
  });

  test('reads the tracked content instead of the file on disk', async () => {
    const cwd = makeCwd();
    // ディスク上は引数を使っているが、追跡内容は未使用引数を持つ。
    writeFileSync(join(cwd, 'drifted.py'), 'def callback(value):\n    return value\n');
    const content = 'def callback(value, unused):\n    return value\n';

    const result = await createPythonAnalyzer({ cwd }).analyze([
      { path: 'drifted.py', content, bytes: Buffer.byteLength(content), revision: 'test' },
    ]);

    expect(result['drifted.py']?.lint_unused_param).toMatchObject({ verdict: 'NG', source: 'python' });
    expect(result['drifted.py']?.lint_unused_param.detail).toContain('callback:unused:L1');
  });
});
