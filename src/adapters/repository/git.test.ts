import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TrackedFile } from '../../review/ports.js';
import { createGitRepository } from './git.js';

const execFileAsync = promisify(execFile);

/** 利用者の git 設定 (署名や hooks) に左右されないよう、commit に要る設定をその場で渡す。 */
async function git(cwd: string, ...args: string[]): Promise<void> {
  const config = ['-c', 'user.name=jeview', '-c', 'user.email=jeview@example.com', '-c', 'commit.gpgsign=false'];
  await execFileAsync('git', [...config, ...args], { cwd });
}

async function write(cwd: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
}

async function commit(cwd: string, files: Record<string, string>, message: string): Promise<void> {
  await write(cwd, files);
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-q', '--no-verify', '-m', message);
}

const contents = (files: readonly TrackedFile[]) => files.map((f) => [f.path, f.content]);

let tmp: string;
let root: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'jeview-git-'));
  root = join(tmp, 'repo');
  await mkdir(root);
  await git(root, 'init', '-q');
  await commit(
    root,
    {
      'README.md': 'root\n',
      'pkg/README.md': 'pkg\n',
      'pkg/edited.ts': 'export const a = 1;\n',
      'staged.ts': 'export const s = 1;\n',
      'gone.ts': 'export const g = 1;\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'image.bin': 'a\0b',
    },
    'init',
  );
  await write(root, {
    'pkg/edited.ts': 'export const a = 2;\n',
    'pkg/new.ts': 'export const n = 1;\n',
    'staged.ts': 'export const s = 2;\n',
    'untracked.ts': 'export const u = 1;\n',
    'pnpm-lock.yaml': 'lockfileVersion: 10\n',
    'image.bin': 'a\0c',
  });
  await rm(join(root, 'gone.ts'));
  await git(root, 'add', 'staged.ts');
  await git(root, 'add', '-N', 'pkg/new.ts');
});

afterAll(() => rm(tmp, { recursive: true, force: true }));

describe('createGitRepository', () => {
  it('lists files with unstaged changes, reads the working tree, and reports the rest as exclusions', async () => {
    const { files, exclusions } = await createGitRepository(root).listDiff();
    // staged.ts は git add 済み、untracked.ts は Git に知らせていないので、どちらも diff には出ない。
    expect(contents(files)).toEqual([
      ['pkg/edited.ts', 'export const a = 2;\n'],
      ['pkg/new.ts', 'export const n = 1;\n'],
    ]);
    expect(exclusions).toEqual([
      { path: 'gone.ts', reason: 'deleted' },
      { path: 'image.bin', reason: 'binary' },
      { path: 'pnpm-lock.yaml', reason: 'lock_file' },
    ]);
  });

  it('limits all and diff to the current directory and reads paths relative to it', async () => {
    const repo = createGitRepository(join(root, 'pkg'));
    expect(contents((await repo.listAll()).files)).toEqual([
      ['README.md', 'pkg\n'],
      ['edited.ts', 'export const a = 2;\n'],
      ['new.ts', 'export const n = 1;\n'],
    ]);
    expect(contents((await repo.listDiff()).files)).toEqual([
      ['edited.ts', 'export const a = 2;\n'],
      ['new.ts', 'export const n = 1;\n'],
    ]);
  });

  it('lists a file with a merge conflict once', async () => {
    const dir = join(tmp, 'conflict');
    await mkdir(dir);
    await git(dir, 'init', '-q');
    await commit(dir, { 'a.ts': 'base\n' }, 'base');
    await git(dir, 'checkout', '-q', '-b', 'other');
    await commit(dir, { 'a.ts': 'other\n' }, 'other');
    await git(dir, 'checkout', '-q', '-');
    await commit(dir, { 'a.ts': 'mine\n' }, 'mine');
    await expect(git(dir, 'merge', '-q', 'other')).rejects.toThrow();

    const repo = createGitRepository(dir);
    expect((await repo.listAll()).files.map((f) => f.path)).toEqual(['a.ts']);
    expect((await repo.listDiff()).files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('diffs against where HEAD split from the base, as a pull request shows', async () => {
    const dir = join(tmp, 'pull-request');
    await mkdir(dir);
    await git(dir, 'init', '-q', '-b', 'trunk');
    await commit(dir, { 'kept.ts': 'k\n', 'edited.ts': '1\n', 'gone.ts': 'g\n' }, 'base');
    await git(dir, 'checkout', '-q', '-b', 'feature');
    await rm(join(dir, 'gone.ts'));
    await commit(dir, { 'edited.ts': '2\n', 'added.ts': 'a\n' }, 'feature');
    await git(dir, 'checkout', '-q', 'trunk');
    await commit(dir, { 'trunk-only.ts': 't\n' }, 'trunk moves on');
    await git(dir, 'checkout', '-q', 'feature');
    await write(dir, { 'kept.ts': 'k2\n' });

    const repo = createGitRepository(dir);
    const { files, exclusions } = await repo.listDiff(await repo.mergeBase('trunk'));
    // trunk-only.ts は PR の外で trunk が進んだ分なので出ない。まだ commit していない kept.ts は作業ツリーから読む。
    expect(contents(files)).toEqual([
      ['added.ts', 'a\n'],
      ['edited.ts', '2\n'],
      ['kept.ts', 'k2\n'],
    ]);
    expect(exclusions).toEqual([{ path: 'gone.ts', reason: 'deleted' }]);
  });

  it('includes staged changes when the base is HEAD', async () => {
    const repo = createGitRepository(root);
    const { files } = await repo.listDiff(await repo.mergeBase('HEAD'));
    expect(files.map((f) => f.path)).toEqual(['pkg/edited.ts', 'pkg/new.ts', 'staged.ts']);
  });

  it('reads no symlink and nothing whose real place is outside the repository', async () => {
    const dir = join(tmp, 'links');
    const outside = join(tmp, 'outside');
    await write(outside, { 'secret.txt': 'secret\n', 'a.ts': 'secret\n' });
    await mkdir(dir);
    await git(dir, 'init', '-q');
    await mkdir(join(dir, 'pkg'));
    await symlink('AGENTS.md', join(dir, 'CLAUDE.md'));
    await symlink(join(outside, 'secret.txt'), join(dir, 'escape.txt'));
    await commit(dir, { 'AGENTS.md': 'agents\n', 'pkg/a.ts': 'export const a = 1;\n' }, 'links');
    // 追跡しているディレクトリを、手元でリポジトリの外へのリンクに置き換える。
    await rm(join(dir, 'pkg'), { recursive: true });
    await symlink(outside, join(dir, 'pkg'));

    const { files, exclusions } = await createGitRepository(dir).listAll();
    expect(files.map((f) => f.path)).toEqual(['AGENTS.md']);
    expect(exclusions).toEqual([
      { path: 'CLAUDE.md', reason: 'symlink' },
      { path: 'escape.txt', reason: 'symlink' },
      { path: 'pkg/a.ts', reason: 'outside_repository' },
    ]);
  });

  it('says how to fix a base it cannot find', async () => {
    await expect(createGitRepository(root).mergeBase('no-such-branch')).rejects.toThrow(/"no-such-branch".*fetch/);
  });
});
