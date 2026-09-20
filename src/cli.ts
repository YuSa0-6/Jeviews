#!/usr/bin/env node
// jeview all: Git 追跡ファイル全体を scan する最小 CLI。
// stdout にバージョン付き JSON を一つ、進捗と診断は stderr。
// 終了コード: 0 = 完了、1 = 失敗または部分結果。

import { createProviderFromEnv, detectProvider, isProviderId } from './adapters/providers/registry.js';
import { createGitRepository } from './adapters/repository/git.js';
import type { ProviderId, ReviewOutput } from './review/output.js';
import { DEFAULT_MAX_STATE_BYTES, reviewAll } from './review/review.js';
import { DEFAULT_THRESHOLDS } from './review/verdict.js';

const USAGE = `usage: jeview all [--provider typesafe|vercel-gateway] [--model <name>] [--max-state-bytes <n>] [--concurrency <n>]

provider (default: typesafe when TYPESAFE_API_KEY is set, otherwise vercel-gateway when AI_GATEWAY_API_KEY is set):
  typesafe         TypeSafe API direct.       env TYPESAFE_API_KEY, optional TYPESAFE_BASE_URL (https://api.typesafe.ai)
  vercel-gateway   Vercel AI Gateway.         env AI_GATEWAY_API_KEY, optional AI_GATEWAY_BASE_URL (https://ai-gateway.vercel.sh/v4/ai)
                   default model typesafe-ai/jev
`;

function fail(code: string, message: string, provider: ProviderId | null = null): never {
  const out: ReviewOutput = {
    schemaVersion: 1,
    run: {
      id: '',
      scope: 'all',
      mode: 'scan',
      provider,
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

interface CliOptions {
  provider?: ProviderId;
  model?: string;
  maxStateBytes?: number;
  concurrency?: number;
}

function positiveInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail('config', `${flag} must be a positive integer, got "${raw}"`);
  return n;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail('config', `missing value for ${a}`);
      return v;
    };
    if (a === '--provider') {
      const v = next();
      if (!isProviderId(v)) fail('config', `unknown provider "${v}"\n${USAGE}`);
      opts.provider = v;
    } else if (a === '--model') opts.model = next();
    else if (a === '--max-state-bytes') opts.maxStateBytes = positiveInt(a, next());
    else if (a === '--concurrency') opts.concurrency = positiveInt(a, next());
    else fail('config', `unknown option ${a}\n${USAGE}`);
  }
  return opts;
}

/** .env.local と .env をこの順で読む。シェルで設定済みの値が優先される。 */
function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

function providerOrFail(id: ProviderId, model: string | undefined) {
  try {
    return createProviderFromEnv(id, model, process.env);
  } catch (e) {
    return fail('config', (e as Error).message, id);
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
  const providerId = opts.provider ?? detectProvider(process.env);
  if (!providerId) fail('config', 'set TYPESAFE_API_KEY or AI_GATEWAY_API_KEY (see .env.example)');
  const provider = providerOrFail(providerId, opts.model);

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
    providerId,
    model: provider.model,
    snapshotId,
    files: listed.files,
    exclusions: listed.exclusions,
    log: (line) => process.stderr.write(line + '\n'),
  };
  if (opts.maxStateBytes !== undefined) deps.maxStateBytes = opts.maxStateBytes;
  if (opts.concurrency !== undefined) deps.concurrency = opts.concurrency;

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
  // 失敗したファイルがあれば、理由の種類ごとに 1 行ずつ出す。同じ理由の繰り返しは件数にまとめる。
  const reasons = new Map<string, number>();
  for (const f of out.files) {
    if (!f.error) continue;
    const key = `${f.error.code}: ${f.error.message.split('\n')[0]?.slice(0, 300)}`;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  for (const [key, n] of reasons) process.stderr.write(`jeview: ${n} file(s) failed with ${key}\n`);
  process.exit(out.run.status === 'completed' ? 0 : 1);
}

main().catch((e) => fail('unexpected', (e as Error).stack ?? String(e)));
