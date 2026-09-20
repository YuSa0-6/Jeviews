# evals

Jev の判定精度を、言語ごとの大きめの OSS に対して測り、記録するための仕組みです。
「質問文を変えたら何がどう動いたか」を後から再評価できるように、対象ファイルの一覧・期待値・scan 結果をすべてこの下に置きます。

## 構成

| 場所 | 中身 | git 管理 |
| --- | --- | --- |
| `repos.json` | 対象 repo、固定するコミット、抽出条件、部分集合の大きさ | する |
| `<repo>/<subset>.files.txt` | 抽出したファイル一覧。再抽出しなくても同じ集合で scan できる | する |
| `<repo>/<subset>.expected.json` | 観点ごとの期待値（problem / clean）と出所（tsc / rubocop / ruff / gofmt / human） | する |
| `<repo>/<subset>.human.json` | 人が付けた期待値。`teacher.mjs` を再実行しても消えない | する |
| `<repo>/<subset>.codex.json` | Codex（gpt-6-astra）のレビューから写した期待値。problem だけ。`codex.mjs` が作る | する |
| `<repo>/results/<subset>.<questionVersion>.r<N>.json` | scan の生の結果 | する |
| `history.jsonl` | 採点結果の履歴（1 行 1 scan） | する |
| `.work/<repo>-<subset>/` | 部分集合を単独の git repo にしたもの。`jeview all` の入力 | しない |

OSS の clone は `repos.json` の `ossRoot`（既定は Jeviews の 1 つ上、つまり `~/workspace/oss/`）に置きます。

## 使い方

```sh
pnpm eval:sample [repo...]              # 部分集合を作る（clone が pin と一致していること）
pnpm eval:teacher <repo> <subset>       # linter / formatter から期待値を作る
pnpm eval:scan <repo> <subset>          # jeview で scan して results に残す
pnpm eval:score <repo> <subset> [latest|all] [record|dry]   # 採点して history に追記
pnpm eval:diff <repo> <subset>          # 食い違い (fp / fn) を一覧する
pnpm eval:codex <repo> <subset> <file>  # codex exec の出力を期待値 (problem のみ) に写す
```

## 部分集合

repo ごとに `tune` と `holdout` の 2 つを、ファイルパスのハッシュ順で決定的に選びます。
質問文や閾値の調整は `tune` だけを見て行い、精度の主張は `holdout` の数字で行います。
`jeviews/self` は自分自身の 21 ファイルで、回帰確認用です。

## 期待値の作り方

期待値の粒度は「そのファイルにその観点の指摘が 1 つ以上あるか」です。Jev がファイル単位で答えるためです。
写せる観点だけを書き、写せない観点は unknown として分母に入れません。

| 言語 | 道具 | 写せる観点 |
| --- | --- | --- |
| TypeScript | tsc `--noUnusedLocals --noUnusedParameters`（TS6133 の行を見て import / 変数 / 引数に分ける）、prettier、fallow health | lint_unused_*、format_*（prettier が通るファイルは clean）、complexity_branchy_function（関数の cyclomatic が 15 以上なら problem、8 以下なら clean） |
| Ruby | rubocop（Lint/UnusedMethodArgument、UselessAssignment、SuppressedException、LiteralAsCondition、UnreachableCode、Layout/*、Style/StringLiterals） | lint_unused_param / variable、error_empty_catch、lint_constant_condition、lint_unreachable、format_* |
| Python | ruff check（F401、F841、ARG00x、S110、E101、W191）、ruff format | lint_unused_*、error_empty_catch、format_* |
| Go | gofmt、go vet（通れば未使用 import / 変数は無い）、staticcheck | format_*、lint_unused_import / variable |

error_empty_catch は道具が「問題あり」と言ったものだけを使います。rubocop / ruff の「空の rescue / except」は Jeviews の問い（握りつぶし）より狭いので、道具の clean を clean とは扱いません。

入力検証、エラー処理の大半、秘密情報の観点には道具の正解がありません。Codex（gpt-6-astra）に Jeviews と同じ質問を投げたレビュー結果を `codex.json` に写し、「問題あり」だけを正解にします。レビューは網羅的ではないので、書かれていないファイルを clean とは扱いません。`human.json` に人が書いたものは最優先です。

## 採点

- 観点ごと: NG を陽性として precision / recall / accuracy。needs_context で判定を保留した分は abstain として別に数える
- coveredAccuracy: 正解のある観点だけで組み立てたファイル判定（1 つでも problem なら NG、全部 clean なら GOOD）と Jev の判定が一致した割合。主要な指標
- fileAccuracy: 適用したすべての観点に正解があるファイルだけの一致率。分母が小さいので参考値
- 揺れが ±0.1 あるので、1 つの質問版につき 2 回 scan する

## 止めどき

- `holdout` の coveredAccuracy が 90% 以上になったら、その言語の調整は止める
- 2 回続けて `holdout` が動かなければ、その言語は「収束しない」として記録する
- 1 回の作業で Jev に使う費用は 1 USD まで
