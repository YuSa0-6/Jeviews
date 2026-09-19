#!/usr/bin/env node
// jeview all: Git 追跡ファイル全体を scan する最小 CLI。
// stdout にバージョン付き JSON を一つ、進捗と診断は stderr。
// 終了コード: 0 = 完了、1 = 失敗または部分結果。

import { createTypeSafeProvider } from './adapters/providers/typesafe.js';
import { createGitRepository } from './adapters/repository/git.js';
import type { ReviewOutput } from './review/output.js';
import { DEFAULT_MAX_STATE_BYTES, reviewAll } from './review/review.js';
import { DEFAULT_THRESHOLDS } from './review/verdict.js';

const USAGE = `usage: jeview all [--model <name>] [--max-state-bytes <n>] [--concurrency <n>]

env:
  TYPESAFE_API_KEY   required
  TYPESAFE_BASE_URL  optional, default https://api.typesafe.ai
`;

function fail(code: string, message: string): never {
  const out: ReviewOutput = {
    schemaVersion: 1,
    run: {
      id: '',
      scope: 'all',
      mode: 'scan',
      model: '',
      snapshotId: '',
      policyHash: '',
      thresholds: DEFAULT_THRESHOLDS,
      maxStateBytes: DEFAULT_MAX_STATE_BYTES,
      status: 'failed',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      usage: { requests: 0, inputTokens: null, outputTokens: null, costUsd: null },
      fatalError: { code, message },
    },
    files: [],
    exclusions: [],
  };
  process.stderr.write(`jeview: ${message}\n`);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(1);
}

function parseArgs(argv: string[]): { model?: string; maxStateBytes?: number; concurrency?: number } {
  const opts: { model?: string; maxStateBytes?: number; concurrency?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail('config', `missing value for ${a}`);
      return v;
    };
    if (a === '--model') opts.model = next();
    else if (a === '--max-state-bytes') opts.maxStateBytes = Number(next());
    else if (a === '--concurrency') opts.concurrency = Number(next());
    else fail('config', `unknown option ${a}\n${USAGE}`);
  }
  return opts;
}

/** .env.local と .env をこの順で読む。シェルで設定済みの値が優先される。 */
function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
    } catch {
      // ファイルがなければ何もしない
    }
  }
}

async function main(): Promise<void> {
  loadEnvFiles();
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '--help' || cmd === '-h' || cmd === undefined) {
    process.stderr.write(USAGE);
    process.exit(cmd === undefined ? 1 : 0);
  }
  if (cmd !== 'all') fail('config', `unsupported target "${cmd}". only "all" is implemented.\n${USAGE}`);

  const opts = parseArgs(rest);
  const apiKey = process.env['TYPESAFE_API_KEY'];
  if (!apiKey) fail('config', 'TYPESAFE_API_KEY is not set');

  const providerOpts: Parameters<typeof createTypeSafeProvider>[0] = { apiKey };
  if (opts.model) providerOpts.model = opts.model;
  const baseUrl = process.env['TYPESAFE_BASE_URL'];
  if (baseUrl) providerOpts.baseUrl = baseUrl;
  const provider = createTypeSafeProvider(providerOpts);

  const repo = createGitRepository(process.cwd());
  let snapshotId: string;
  let listed: Awaited<ReturnType<typeof repo.listAll>>;
  try {
    snapshotId = await repo.snapshotId();
    listed = await repo.listAll();
  } catch (e) {
    return fail('repository', (e as Error).message);
  }
  process.stderr.write(
    `jeview all: ${listed.files.length} files, ${listed.exclusions.length} excluded, snapshot ${snapshotId}\n`,
  );

  const deps: Parameters<typeof reviewAll>[0] = {
    provider,
    model: provider.model,
    snapshotId,
    files: listed.files,
    exclusions: listed.exclusions,
    log: (line) => process.stderr.write(line + '\n'),
  };
  if (opts.maxStateBytes !== undefined && Number.isFinite(opts.maxStateBytes)) deps.maxStateBytes = opts.maxStateBytes;
  if (opts.concurrency !== undefined && Number.isFinite(opts.concurrency)) deps.concurrency = opts.concurrency;

  const out = await reviewAll(deps);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  const summary = out.files.reduce<Record<string, number>>((acc, f) => {
    const k = f.verdict ?? 'null';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  process.stderr.write(
    `jeview: status=${out.run.status} ${JSON.stringify(summary)} requests=${out.run.usage.requests} inputTokens=${out.run.usage.inputTokens} costUsd=${out.run.usage.costUsd}\n`,
  );
  process.exit(out.run.status === 'completed' ? 0 : 1);
}

main().catch((e) => fail('unexpected', (e as Error).stack ?? String(e)));
