// Git とファイル取得。`all` は追跡ファイルの作業ツリー内容を対象にする。

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TrackedFile {
  path: string;
  content: string;
  bytes: number;
  revision: string;
}

export interface Exclusion {
  path: string;
  reason: string;
}

export interface Repository {
  root(): Promise<string>;
  snapshotId(): Promise<string>;
  listAll(): Promise<{ files: TrackedFile[]; exclusions: Exclusion[] }>;
}

const EXCLUDED_BASENAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'go.sum',
]);

export function createGitRepository(cwd: string): Repository {
  async function git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  return {
    async root() {
      return (await git(['rev-parse', '--show-toplevel'])).trim();
    },
    async snapshotId() {
      const head = (await git(['rev-parse', 'HEAD'])).trim();
      const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).trim() !== '';
      return dirty ? `${head}+dirty` : head;
    },
    async listAll() {
      const root = await this.root();
      const raw = await git(['ls-files', '-z']);
      const paths = raw.split('\0').filter((p) => p.length > 0);
      const files: TrackedFile[] = [];
      const exclusions: Exclusion[] = [];
      for (const path of paths) {
        const base = path.slice(path.lastIndexOf('/') + 1);
        if (EXCLUDED_BASENAMES.has(base)) {
          exclusions.push({ path, reason: 'lock_file' });
          continue;
        }
        let buf: Buffer;
        try {
          buf = await readFile(join(root, path));
        } catch (e) {
          exclusions.push({ path, reason: `read_failed: ${(e as Error).message}` });
          continue;
        }
        if (looksBinary(buf)) {
          exclusions.push({ path, reason: 'binary' });
          continue;
        }
        files.push({
          path,
          content: buf.toString('utf8'),
          bytes: buf.byteLength,
          revision: createHash('sha256').update(buf).digest('hex'),
        });
      }
      return { files, exclusions };
    },
  };
}

function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}
