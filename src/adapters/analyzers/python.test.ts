import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createPythonAnalyzer } from './python.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('python analyzer', () => {
  test('finds unused parameters without flagging protocol or stub signatures', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'jeview-python-'));
    dirs.push(cwd);
    const sources = {
      'bad.py': 'def callback(value, unused):\n    return value\n',
      'good.py': 'def callback(value):\n    return value\n',
      'protocol.py': 'def __deepcopy__(self, memo):\n    return self\n',
      'stub.py': 'def callback(required):\n    pass\n',
    };
    for (const [path, content] of Object.entries(sources)) writeFileSync(join(cwd, path), content);

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
});
