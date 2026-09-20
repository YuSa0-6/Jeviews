# Jeviews

[Jev](https://docs.typesafe.ai) だけで回す、最小構成のコードレビュー CLI です。
Git 追跡ファイル全体を scan し、ファイルごとの判定を JSON で出力します。

## 必要なもの

- Node.js 22 以上
- pnpm 12
- TypeSafe または Vercel AI Gateway の API キー

## セットアップ

```sh
pnpm install
cp .env.example .env.local   # どちらかのキーを入れる
pnpm run build
```

## 使い方

```sh
node dist/cli.js all
```

開発中は `pnpm dev all` でも同じです。

| オプション | 内容 |
| --- | --- |
| `--provider typesafe\|vercel-gateway` | 呼び出し先。未指定ならキーの有無で自動選択 |
| `--model <name>` | モデル名。Vercel AI Gateway の既定は `typesafe-ai/jev` |
| `--max-state-bytes <n>` | 1 ファイルあたりに送る最大バイト数 |
| `--concurrency <n>` | 並列リクエスト数 |

結果は stdout に JSON、進捗とエラーは stderr に出ます。
終了コードは完了で 0、失敗または部分結果で 1 です。

## 環境変数

| 変数 | 用途 |
| --- | --- |
| `TYPESAFE_API_KEY` | TypeSafe 直結。あれば既定の provider になる |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway 経由 |
| `TYPESAFE_BASE_URL` / `AI_GATEWAY_BASE_URL` | 接続先の上書き（任意） |

## 開発

```sh
pnpm run typecheck
pnpm test
```

## License

MIT
