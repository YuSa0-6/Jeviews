#!/usr/bin/env node
// jeview all: Git 追跡ファイル全体を scan する最小 CLI。
// stdout にバージョン付き JSON を一つ、進捗と診断は stderr。
// 終了コード: 0 = 完了、1 = 失敗または部分結果。

import { writeSync } from 'node:fs';
import { createAnalyzers } from './adapters/analyzers/index.js';
import { createProviderFromEnv, detectProvider, isProviderId } from './adapters/providers/registry.js';
import { createGitRepository } from './adapters/repository/git.js';
import type { ProviderId, ReviewOutput } from './review/output.js';
import { DEFAULT_MAX_STATE_BYTES, reviewAll } from './review/review.js';
import { DEFAULT_THRESHOLDS } from './review/verdict.js';

const USAGE = `usage: jeview all [--provider typesafe|vercel-gateway|openrouter|cloudflare] [--model <name>] [--max-state-bytes <n>] [--concurrency <n>]

provider (default: the first one below whose API key env is set; cloudflare is used only when named):
  typesafe         TypeSafe API direct.       env TYPESAFE_API_KEY, optional TYPESAFE_BASE_URL (https://api.typesafe.ai)
  vercel-gateway   Vercel AI Gateway.         env AI_GATEWAY_API_KEY, optional AI_GATEWAY_BASE_URL (https://ai-gateway.vercel.sh/v4/ai)
                   default model typesafe-ai/jev
  openrouter       OpenRouter Decisions API.  env OPENROUTER_API_KEY, optional OPENROUTER_BASE_URL (https://openrouter.ai/api/v1)
                   default model ~typesafe/jev-latest
  cloudflare       Cloudflare AI REST API.    env CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID,
                   optional CLOUDFLARE_BASE_URL (https://api.cloudflare.com/client/v4)
                   default model typesafe/jev
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
  writeSync(1, JSON.stringify(out, null, 2) + '\n');
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

type OptionParser = (opts: CliOptions, value: string, flag: string) => void;

const OPTIONS: Record<string, OptionParser> = {
  '--provider': (o, v) => {
    if (!isProviderId(v)) fail('config', `unknown provider "${v}"\n${USAGE}`);
    o.provider = v;
  },
  '--model': (o, v) => {
    o.model = v;
  },
  '--max-state-bytes': (o, v, flag) => {
    o.maxStateBytes = positiveInt(flag, v);
  },
  '--concurrency': (o, v, flag) => {
    o.concurrency = positiveInt(flag, v);
  },
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {};
  // フラグを 1 つ取り、続けてその値を取る。
  const args = argv[Symbol.iterator]();
  for (const flag of args) {
    const parse = OPTIONS[flag];
    if (!parse) fail('config', `unknown option ${flag}\n${USAGE}`);
    const { value } = args.next();
    if (value === undefined) fail('config', `missing value for ${flag}`);
    parse(opts, value, flag);
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

const HELP_FLAGS = new Set(['--help', '-h']);

function parseCommand(argv: string[]): string[] {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  if (HELP_FLAGS.has(cmd)) {
    process.stderr.write(USAGE);
    process.exit(0);
  }
  if (cmd !== 'all') fail('config', `unsupported target "${cmd}". only "all" is implemented.\n${USAGE}`);
  return rest;
}

async function listOrFail(repo: ReturnType<typeof createGitRepository>) {
  try {
    const snapshotId = await repo.snapshotId();
    const { files, exclusions } = await repo.listAll();
    return { snapshotId, files, exclusions };
  } catch (e) {
    return fail('repository', (e as Error).message);
  }
}

function verdictCounts(out: ReviewOutput): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of out.files) {
    const k = f.verdict ?? 'null';
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

function failureCounts(out: ReviewOutput): Map<string, number> {
  const reasons = new Map<string, number>();
  for (const f of out.files) {
    if (!f.error) continue;
    const key = `${f.error.code}: ${f.error.message.split('\n')[0]?.slice(0, 300)}`;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  return reasons;
}

function writeSummary(out: ReviewOutput): void {
  const u = out.run.usage;
  process.stderr.write(
    `jeview: status=${out.run.status} ${JSON.stringify(verdictCounts(out))} requests=${u.requests} inputTokens=${u.inputTokens} costUsd=${u.costUsd}\n`,
  );
  for (const [key, n] of failureCounts(out)) process.stderr.write(`jeview: ${n} file(s) failed with ${key}\n`);
}

function toDeps(
  opts: CliOptions,
  provider: ReturnType<typeof providerOrFail>,
  providerId: ProviderId,
  target: Awaited<ReturnType<typeof listOrFail>>,
): Parameters<typeof reviewAll>[0] {
  const deps: Parameters<typeof reviewAll>[0] = {
    provider,
    providerId,
    model: provider.model,
    ...target,
    analyzers: createAnalyzers(process.cwd()),
    log: (line) => process.stderr.write(line + '\n'),
  };
  if (opts.maxStateBytes !== undefined) deps.maxStateBytes = opts.maxStateBytes;
  if (opts.concurrency !== undefined) deps.concurrency = opts.concurrency;
  return deps;
}

async function main(): Promise<void> {
  loadEnvFiles();
  const opts = parseArgs(parseCommand(process.argv.slice(2)));
  const providerId = opts.provider ?? detectProvider(process.env);
  if (!providerId) {
    fail(
      'config',
      'set TYPESAFE_API_KEY, AI_GATEWAY_API_KEY or OPENROUTER_API_KEY, or pass --provider cloudflare with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (see .env.example)',
    );
  }
  const provider = providerOrFail(providerId, opts.model);
  const target = await listOrFail(createGitRepository(process.cwd()));
  process.stderr.write(
    `jeview all: ${target.files.length} files, ${target.exclusions.length} excluded, snapshot ${target.snapshotId}\n`,
  );

  const out = await reviewAll(toDeps(opts, provider, providerId, target));
  writeSync(1, JSON.stringify(out, null, 2) + '\n');
  writeSummary(out);
  process.exit(out.run.status === 'completed' ? 0 : 1);
}

main().catch((e) => fail('unexpected', (e as Error).stack ?? String(e)));
