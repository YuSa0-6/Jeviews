# jeview

リポジトリの中身をまとめて [Jev](https://docs.typesafe.ai) に見てもらい、
「気になるファイルはどれか」を JSON で返すコマンドです。
プロジェクト名は Jeviews、コマンドと npm パッケージの名前は `jeview` です。

大きなリポジトリを前にして「どこから読めばいいか」を決めたいときに使います。

まだ実験段階です。コマンドや出力の形は予告なく変わることがあります。TypeSafe AI の公式ツールではありません。

## できること

- Git で追跡しているファイルを一通り scan する
- ファイルごとに `GOOD` / `NG` / `NEED_REVIEW` の判定を付ける
- 判定の根拠になった確率をそのまま残すので、あとから閾値を変えて読み直せる

見ている観点は 5 つです。

| 観点 | 何を見るか |
| --- | --- |
| input_validation | 外から受け取った値を確認せずに使っていないか |
| error_handling | 失敗したときの扱いが抜けていないか |
| secret_exposure | 鍵やトークンがファイルに書かれていないか |
| formatting | 整形が崩れていないか |
| lint | 明らかな書き方の問題がないか |

ファイルの種類によって使う観点を絞ります。テスト（`*.test.ts`、`*_spec.rb`、`spec/` や `test/` の配下など）には整形と秘密情報だけ、設定やドキュメントにはさらに少ない観点だけを当てます。`.env.example` のような雛形ファイルには秘密情報の観点を当てません。空の値と本物の鍵を Jev が区別できないためです。

## はじめかた

必要なのは Node.js 22 以上と、次のどちらかの API キーです。

- TypeSafe のキー（`TYPESAFE_API_KEY`）
- Vercel AI Gateway のキー（`AI_GATEWAY_API_KEY`）

キーの渡し方は 3 つです。どれか 1 つで動きます。

| 方法 | 書く場所 | 向いている場面 |
| --- | --- | --- |
| 環境変数 | シェルで `export TYPESAFE_API_KEY=...` | 手元で 1 回試す |
| `.env.local` | 見たいリポジトリの直下に置く。`.gitignore` に入れておく | 手元で繰り返し使う |
| CI の secret | GitHub Actions なら `env:` に `${{ secrets.TYPESAFE_API_KEY }}` | CI |

`jeview` は実行したディレクトリの `.env.local` と `.env` をこの順で読み、シェルで設定済みの値を優先します。


## 使いかた

見たいリポジトリの中で実行します。経路は 2 つあり、どちらも同じ `jeview` コマンドが動きます。

**repo に固定して使う**（チーム・Git hook・CI 向け。全員が同じ version で判定できます）

```sh
pnpm add -D jeview
pnpm jeview all > result.json
```

**その場で試す**（install なし）

```sh
npx jeview all > result.json
pnpm dlx jeview all > result.json
```

npm にはまだ公開していません。それまでは clone して `pnpm install && pnpm run build` のあと `node dist/cli.js all` で同じものが動きます。

結果は stdout に JSON で出ます。進捗とエラーは stderr に出るので、
上のように stdout だけファイルへ落とせます。

| 終了コード | 意味 |
| --- | --- |
| 0 | 全ファイルの判定が終わった |
| 1 | 途中で失敗した、または一部のファイルが判定できなかった |

### オプション

| オプション | 用途 |
| --- | --- |
| `--provider typesafe` / `--provider vercel-gateway` | 接続先を指定する。省略時はキーがある方を使う |
| `--model <name>` | モデルを変える。Vercel AI Gateway の既定は `typesafe-ai/jev` |
| `--max-state-bytes <n>` | これより大きいファイルは送らずに `NEED_REVIEW` にする |
| `--concurrency <n>` | 同時に送るリクエスト数 |

## 結果の読みかた

`files[]` の各要素がファイル 1 つに対応します。まず `verdict` を見てください。

| verdict | 意味 | 次にすること |
| --- | --- | --- |
| `GOOD` | どの観点でも問題は見つからなかった | 後回しにしてよい |
| `NG` | いずれかの観点で問題の確率が高い | 先に読む |
| `NEED_REVIEW` | このファイルだけでは判断できない、または大きすぎて送っていない | 周辺ファイルと一緒に人が見る |
| `null` | API エラーなどで判定できなかった | `error` を確認して再実行する |

観点ごとの詳しい結果は `checks[]` にあります。
`problem.probability` が「問題がある確率」、`needsContext.probability` が「他のファイルを見ないと判断できない確率」です。

既定の閾値は `run.thresholds` に出力されます。

| 値 | 既定 | 意味 |
| --- | --- | --- |
| problemHigh | 0.65 | これ以上で `NG`。lint の観点だけ 0.80（大きなファイルで未使用コードの誤検知が多いため） |
| problemLow | 0.35 | これ未満で問題なし。間は `NEED_REVIEW` 相当として確率だけ残す |
| needsContextHigh | 0.65 | これ以上で `NEED_REVIEW` |

`run.usage` にリクエスト数とトークン数が出るので、コストの見当も付きます。

## 知っておくと安心なこと

- ファイルの中身は API キーで指定した接続先にそのまま送られます。送りたくないファイルがあるリポジトリでは使わないでください
- Vercel AI Gateway の無料枠はレートリミットが厳しめです。大きなリポジトリでは `--concurrency` を下げるか TypeSafe 直結を使ってください
- 判定は Jev の確率にもとづく目安です。最終的な判断は人が行う前提で作っています

## 困ったときは

質問や不具合は [GitHub の Issue](https://github.com/YuSa0-6/Jeviews/issues) に書いてください。誤検知や見逃しの報告は、どのファイルのどの観点がどう間違ったかを添えてもらえると助かります。

## 貢献するには

小さな修正や質問だけでも歓迎です。手順は [CONTRIBUTING.md](CONTRIBUTING.md) にあります。参加するすべての人に [行動規範](CODE_OF_CONDUCT.md) が適用されます。

## License

MIT License. Copyright (c) 2026 Yusa (YuSa0-6). 全文は [LICENSE](LICENSE) を参照してください。
