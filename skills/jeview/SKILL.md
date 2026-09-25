---
name: jeview
description: jeview（ファイルごとに問題がありそうかを Jev に聞くコードレビュー CLI）を実行し、結果の JSON から先に読むべきファイルを選んで、コードを読んで確かめてから報告する。リポジトリ全体のレビュー、commit 前の変更の確認、PR の差分の確認を頼まれたとき、または jeview の結果（result.json）を読むときに使う。
---

# jeview でコードを見る

jeview は、Git で管理しているファイルを 1 つずつ Jev（TypeSafe AI の評価モデル）に送り、観点ごとに「問題がある確率」を聞いて、ファイルごとに `GOOD` / `NG` / `NEED_REVIEW` を付ける CLI です。結果は JSON で stdout に出ます。

判定は確率にもとづく目安です。`NG` は「先に読むファイル」として扱い、コードを読んで確かめたものを問題として報告します。

## 1. 起動コマンドを決める

| 順 | 試すこと | 通ったら使うコマンド |
|---|---|---|
| 1 | `npx --no-install jeview --help` | `npx --no-install jeview` |
| 2 | ユーザーに Jeviews を clone した場所を聞く | `node <clone した場所>/dist/cli.js` |

以下では、決めたコマンドを `jeview` と書きます。

## 2. 対象を選ぶ

ユーザーが対象（`all` / `diff` / `diff --base <ref>`）を指定していれば、それを使います。指定がなければ、頼まれたことから選びます。

| 頼まれたこと | コマンド |
|---|---|
| commit 前の変更を見る | `jeview diff --base HEAD` |
| PR やブランチの差分を見る | `git fetch origin` のあと `jeview diff --base origin/<base ブランチ>` |
| リポジトリ全体を見る | `jeview all` |

- リポジトリの直下で実行します。対象は実行したディレクトリの配下で、`.env.local` もそこから読みます
- base ブランチが分からなければ、`git symbolic-ref --short refs/remotes/origin/HEAD` が既定のブランチ（例: `origin/main`）を返します
- まだ Git に登録していない新しいファイルは対象の外です。含めるときは、ユーザーに確かめてから `git add -N <ファイル>` を実行します
- ファイルの中身は外部の API に送られます。ユーザーが jeview を指定していないときは、実行してよいか先に聞きます

## 3. 実行する

```sh
jeview diff --base HEAD > result.json 2> jeview.log; echo "exit=$?"
grep '^jeview' jeview.log
```

| 出たもの | 意味 |
|---|---|
| `exit=0` | 全ファイルの判定が終わった |
| `exit=1` | 失敗した、または一部のファイルを判定できなかった。「うまくいかないとき」を見る |
| `jeview: status=... {"NG":1,"GOOD":2} ...` | 判定ごとのファイル数、リクエスト数、費用（USD） |

- 進捗は stderr にファイル 1 つにつき 1 行出ます。jeview.log に落とし、`grep '^jeview'` で要約だけを読みます
- API キー（`TYPESAFE_API_KEY` / `AI_GATEWAY_API_KEY` / `OPENROUTER_API_KEY` のどれか 1 つ）は環境変数か `.env.local` から読まれます。キーが無いと言われたら、ユーザーに `.env.local` へ書いてもらいます。キーの値はチャットで受け取らず、表示もしません
- result.json と jeview.log は作業用のファイルです。commit には含めません

## 4. 結果を読む

```sh
# NG の観点: ファイル / 観点 / 問題の確率（静的解析で決めた観点は、行番号などの根拠）
jq -r '.files[] | select(.verdict == "NG") | .path as $p | .checks[] | select(.verdict == "NG") | [$p, .checkId, (.problem.probability // .evidence.detail)] | @tsv' result.json

# NEED_REVIEW の理由: needs_context = ほかのファイルも見ないと判断できない / input_too_large = 大きすぎて送っていない
jq -r '.files[] | select(.verdict == "NEED_REVIEW") | .path as $p | .checks[] | select(.reason == "needs_context" or .reason == "input_too_large") | [$p, .checkId, .reason] | @tsv' result.json

# 判定できなかったファイル
jq -r '.files[] | select(.error) | [.path, .error.code, .error.message] | @tsv' result.json
```

jq が無ければ、result.json を読んで同じ項目を拾います。

## 5. 確かめて報告する

1. NG の観点を、問題の確率が高い順に確かめます。ファイルを開き、観点に当てはまる箇所を探します（観点の意味は下の表）
2. Jev はファイル単位で答えるので、場所は自分で探します。`evidence.detail` があれば、そこに行番号が書いてあります
3. 報告は表にします: ファイル / 行 / 観点 / 見つけたこと。見つからなかった観点は「確認できず（誤検知の可能性）」として別の表にします
4. NEED_REVIEW のファイルは、呼び出し元やテストなど周りのファイルと合わせて読みます
5. 修正は、ユーザーが頼んだときに行います

## 観点の意味

| checkId | 探すもの |
|---|---|
| `input_unchecked_use` | 外から読んだ値（コマンドライン引数・環境変数・通信の応答・ファイル）を、形を確かめずに数値・URL・パス・決まった選択肢として使っている |
| `input_missing_unhandled` | 外から読んだ値が無い・空のときも、あるものとして使い続けている |
| `error_empty_catch` | catch などでエラーを受け取り、記録も再送出も失敗の返却もせずに捨てている |
| `error_success_after_failure` | 処理が失敗したあとに、成功として返す・続ける |
| `error_unhandled_promise` | Promise などの非同期処理の失敗を、await も処理もしていない |
| `secret_hardcoded` | API キー・パスワード・トークン・秘密鍵の値がそのまま書いてある |
| `secret_logged` | 秘密の値をログ・標準出力・エラーメッセージに出している |
| `format_indentation` | タブとスペース、またはインデント幅が混ざっている |
| `format_quotes` | 文字列のシングル / ダブルクォートの使い分けに決まりがない |
| `format_spacing` | 演算子・カンマ・括弧まわりの空白がそろっていない |
| `lint_unused_import` | 使っていない import |
| `lint_unused_variable` | 使っていない変数 |
| `lint_unused_param` | 使っていない引数 |
| `lint_unreachable` | return や throw のあとなど、実行されないコード |
| `lint_duplicate_condition` | if / else や switch で同じ条件が重なり、あとの分岐に届かない |
| `lint_constant_condition` | いつも true、またはいつも false になる条件 |
| `complexity_branchy_function` | 分岐（if・ループ・case・catch・三項演算子・論理演算子）が 15 以上ある関数 |

## うまくいかないとき

| 出たもの | 意味 | 次にすること |
|---|---|---|
| `run.fatalError.code` が `config` | キーが無い、またはオプションの書きまちがい | stderr の 1 行目を読んで直す |
| `run.fatalError.code` が `repository` | Git の外で実行した、または `--base` の分岐点が見つからない | `git fetch origin`。shallow clone なら `git fetch --unshallow` |
| `error.code` が `auth` | キーの誤り・権限不足・残高切れ（HTTP 401 / 402 / 403） | ユーザーにキーと残高を確かめてもらう |
| `error.code` が `rate_limit` | 送る速さの上限（HTTP 429） | `--concurrency 1` を付けて再実行 |
| `error.code` が `bad_request` | ファイルが大きすぎる、またはモデル名のまちがい（HTTP 400 / 404 / 422） | そのファイルは人が読む。`--model` を付けていれば見直す |
| `error.code` が `server` / `network` / `invalid_response` | 接続先の不調、または通信の失敗 | 少し待って再実行 |
