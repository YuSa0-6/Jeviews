// Git とファイル取得。`all` は追跡ファイル、`diff` はインデックス (--base なら分岐点のコミット) との差分がある
// ファイルの作業ツリー内容を対象にする。
// どちらも cwd 配下が対象で、git は cwd からのパスを返すので cwd から読む。
// シンボリックリンクと、実際の場所がリポジトリの外にあるファイルは読まずに除外する (中身を API に送らない)。

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Exclusion, Repository, TrackedFile } from '../../review/ports.js';

const execFileAsync = promisify(execFile);

const EXCLUDED_BASENAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'go.sum',
]);

// --relative: ls-files と同じく cwd 配下を cwd からのパスで返させる。利用者の diff.relative 設定にも左右されない。
// --no-renames: 改名を「消したファイル」と「新しいファイル」に分け、消した側も除外として報告する。
const DIFF_ARGS = ['diff', '--name-only', '-z', '--relative', '--no-renames'];

export function createGitRepository(cwd: string): Repository {
  async function git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  /** git が NUL 区切りで返すパス。衝突中のファイルは ls-files だと段の数、diff だと 2 回出るので 1 つにまとめる。 */
  async function paths(args: string[]): Promise<string[]> {
    return [...new Set((await git(args)).split('\0').filter((p) => p.length > 0))];
  }

  /** リポジトリの直下の実際の場所。読むファイルの実際の場所がこの外にあれば読まない。 */
  async function root(): Promise<string> {
    return realpath((await git(['rev-parse', '--show-toplevel'])).trim());
  }

  return {
    async snapshotId() {
      const head = (await git(['rev-parse', 'HEAD'])).trim();
      const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).trim() !== '';
      return dirty ? `${head}+dirty` : head;
    },
    async listAll() {
      return readFiles(cwd, await root(), await paths(['ls-files', '-z']));
    },
    async listDiff(commit) {
      const against = commit === undefined ? [] : [commit];
      const [changed, deleted] = await Promise.all([
        paths([...DIFF_ARGS, '--diff-filter=d', ...against]),
        paths([...DIFF_ARGS, '--diff-filter=D', ...against]),
      ]);
      const { files, exclusions } = await readFiles(cwd, await root(), changed);
      return { files, exclusions: [...deleted.map((path) => ({ path, reason: 'deleted' })), ...exclusions] };
    },
    async mergeBase(ref) {
      try {
        return (await git(['merge-base', ref, 'HEAD'])).trim();
      } catch (e) {
        // 共通の祖先が無いとき git は何も言わずに 1 で終わる。shallow clone で base の履歴が無いときもこうなる。
        throw new Error(
          `cannot find where HEAD split from "${ref}". fetch the base branch, and fetch more history in a shallow clone (e.g. fetch-depth: 0): ${(e as Error).message}`,
        );
      }
    },
  };
}

async function readFiles(
  cwd: string,
  root: string,
  paths: readonly string[],
): Promise<{ files: TrackedFile[]; exclusions: Exclusion[] }> {
  const files: TrackedFile[] = [];
  const exclusions: Exclusion[] = [];
  for (const path of paths) {
    const read = await readTracked(path, join(cwd, path), root);
    if ('reason' in read) exclusions.push(read);
    else files.push(read);
  }
  return { files, exclusions };
}

/** 1 ファイルを読む。読まないファイルは除外の理由を返す。 */
async function readTracked(path: string, full: string, root: string): Promise<TrackedFile | Exclusion> {
  if (EXCLUDED_BASENAMES.has(path.slice(path.lastIndexOf('/') + 1))) return { path, reason: 'lock_file' };
  try {
    // リンク先は、別に追跡しているファイルか、Git の外 (リポジトリの外かもしれない) の中身なので読まない。
    if ((await lstat(full)).isSymbolicLink()) return { path, reason: 'symlink' };
    // 途中のディレクトリが手元でリンクに置き換わっていると、ファイル自体はリンクでなくても外を指す。
    if (!isInside(root, await realpath(full))) return { path, reason: 'outside_repository' };
    const buf = await readFile(full);
    if (looksBinary(buf)) return { path, reason: 'binary' };
    return {
      path,
      content: buf.toString('utf8'),
      bytes: buf.byteLength,
      revision: createHash('sha256').update(buf).digest('hex'),
    };
  } catch (e) {
    return { path, reason: `read_failed: ${(e as Error).message}` };
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}
