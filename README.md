# jeview

リポジトリの中身をまとめて [Jev](https://docs.typesafe.ai) に見てもらい、
「気になるファイルはどれか」を JSON で返すコマンドです。
プロジェクト名は Jeviews、コマンドと npm パッケージの名前は `jeview` です。

大きなリポジトリを前にして「どこから読めばいいか」を決めたいときに使います。
commit の前の自分の変更や、上がっている PR の差分だけを確かめるときにも使えます。

まだ実験段階です。コマンドや出力の形は予告なく変わることがあります。TypeSafe AI の公式ツールではありません。

## できること

- Git で追跡しているファイルを一通り scan する（`all`）
- まだ `git add` していない変更があるファイルだけを scan する（`diff`）
- 上がっている PR で変わったファイルだけを scan する（`diff --base`）
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
| complexity | 分岐が多すぎる関数がないか |

ファイルの種類によって使う観点を絞ります。テスト（`*.test.ts`、`*_spec.rb`、`spec/` や `test/` の配下など）には整形と秘密情報だけ、設定やドキュメントにはさらに少ない観点だけを当てます。`.env.example` のような雛形ファイルには秘密情報の観点を当てません。空の値と本物の鍵を Jev が区別できないためです。

## はじめかた

必要なのは Node.js 22 以上と、次のどれか 1 つの API キーです。

| 接続先 | 環境変数 | 既定のモデル |
| --- | --- | --- |
| TypeSafe 直結 | `TYPESAFE_API_KEY` | `jev-latest` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `typesafe-ai/jev` |
| OpenRouter | `OPENROUTER_API_KEY` | `~typesafe/jev-latest` |

キーが複数あるときは、上の表の上から順に最初に見つかった接続先を使います。

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

### 見る範囲

`jeview` の直後に、見るファイルの範囲を書きます。省略すると `diff` を実行します。

| 対象 | 見るファイル | 向いている場面 |
| --- | --- | --- |
| `all` | Git で追跡しているファイルすべて | リポジトリ全体から、先に読むファイルを決める |
| `diff`（省略時） | まだ `git add` していない変更があるファイル（`git diff` に出るもの） | commit の前に、自分の変更を確かめる |
| `diff --base <ref>` | `<ref>` から分かれた後に変わったファイル。commit 済みの変更も含む | 上がっている PR を確かめる |

```sh
pnpm jeview > result.json                         # jeview diff と同じ
pnpm jeview --base origin/main > result.json      # jeview diff --base origin/main と同じ
```

- どれもファイル全体を Jev に送り、ファイルごとに判定します
- 実行したディレクトリの配下を見ます。リポジトリの直下で実行すると全体が対象です
- 新しく作ったファイルを `diff` で見るには、先に `git add -N <ファイル>` で Git に知らせます
- `diff` で消したファイルは、結果の `exclusions` に `"reason": "deleted"` で残ります

### PR の差分を見る

`diff --base <ref>` は、HEAD が `<ref>` から分かれた地点と作業ツリーを比べます。GitHub の PR の「Files changed」と同じ範囲に、まだ commit していない手元の変更が加わります。

| 場面 | 手順 |
| --- | --- |
| 上がっている PR を手元で見る | `gh pr checkout 123`（GitHub CLI）で PR のブランチに切り替えてから `jeview diff --base origin/main` |
| GitHub Actions で PR ごとに見る | `actions/checkout` に `fetch-depth: 0` を付け、`jeview diff --base origin/${{ github.base_ref }}` |
| commit していない変更をまとめて見る | `jeview diff --base HEAD`（`git add` 済みの変更も含む） |

- 分かれた地点を求めるために base の履歴を使います。shallow clone では `fetch-depth: 0` などで履歴を取ってください
- GitHub Actions では `pull_request` をきっかけにします。fork からの PR には Secrets が渡らないので、API キーが守られます（`pull_request_target` は fork のコードに Secrets を渡すので避けます）
- 比べた起点は、結果の `run.base` に `{ "ref": "origin/main", "mergeBase": "<コミット>" }` の形で残ります

### オプション

| オプション | 用途 |
| --- | --- |
| `--base <ref>` | `diff` で比べる起点を、HEAD が `<ref>` から分かれた地点にする。PR の差分を見るときに使う |
| `--provider typesafe` / `vercel-gateway` / `openrouter` | 接続先を指定する。省略時はキーがあるものを上の表の順で使う |
| `--model <name>` | モデルを変える。既定は上の表のとおり。OpenRouter で版を固定するなら `typesafe/jev-1.13` |
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

Jev に送らなかったファイルは、`exclusions[]` に理由付きで残ります。

| reason | 意味 |
| --- | --- |
| `lock_file` | `pnpm-lock.yaml` などの lock ファイル |
| `binary` | バイナリファイル |
| `symlink` | シンボリックリンク。リンク先は、別に追跡しているファイルか Git の外の中身なので読みません |
| `outside_repository` | 実際の場所がリポジトリの外にある（途中のディレクトリがリンクに置き換わっているなど） |
| `deleted` | `diff` で消したファイル |
| `read_failed: …` | 読めなかった。続けて理由が入る |

## 知っておくと安心なこと

- ファイルの中身は API キーで指定した接続先にそのまま送られます。送りたくないファイルがあるリポジトリでは使わないでください
- 送るのは、実際の場所がリポジトリの中にあるファイルの中身だけです。シンボリックリンクは、リンク先を読まずに除外します
- Vercel AI Gateway の無料枠はレートリミットが厳しめです。大きなリポジトリでは `--concurrency` を下げるか TypeSafe 直結を使ってください
- OpenRouter の Jev は alpha 版の Decisions API（`https://openrouter.ai/api/alpha/decisions`）を使います。API の形が予告なく変わることがあります
- OpenRouter のクレジットが切れると HTTP 402 になり、`error.code` は `auth` になります
- 判定は Jev の確率にもとづく目安です。最終的な判断は人が行う前提で作っています

## 困ったときは

質問や不具合は [GitHub の Issue](https://github.com/YuSa0-6/Jeviews/issues) に書いてください。誤検知や見逃しの報告は、どのファイルのどの観点がどう間違ったかを添えてもらえると助かります。

## 貢献するには

小さな修正や質問だけでも歓迎です。手順は [CONTRIBUTING.md](CONTRIBUTING.md) にあります。参加するすべての人に [行動規範](CODE_OF_CONDUCT.md) が適用されます。

## Claude Code を使う場合

この repo には PreToolUse フックが入っていて、`git commit` / `git push` の前に
`fallow audit` を実行します。実体は `.claude/hooks/fallow-gate.sh` です。
設定は `.claude/settings.json` に commit されているので、clone した全員に適用されます。

- `fallow` が見つからない場合や監査が失敗した場合は、stderr に 1 行出して通します
- よくある書き方を拾う補助であり、回避は可能です。確実に止めたい場合は git hooks を併用してください
- 使わない場合は `.claude/settings.local.json` で上書きできます（このファイルは commit されません）

## License

MIT License. Copyright (c) 2026 Yusa (YuSa0-6). 全文は [LICENSE](LICENSE) を参照してください。
