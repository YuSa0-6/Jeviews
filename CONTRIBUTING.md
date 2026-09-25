# コントリビュートするには

Jeviews に興味を持ってくれてありがとうございます。小さな修正や質問だけでも歓迎です。

## 歓迎する貢献

- 誤検知・見逃しの報告。どのファイルのどの観点が、どう間違ったかを書いてください
- 観点や質問文の改善。`src/review/checks.ts` に集まっています
- 接続先（provider）の追加。`src/adapters/providers/registry.ts` の表に 1 行足す形です
- README の分かりにくい箇所の報告

## まず Issue を立ててください

- **バグ**: Issue テンプレート「バグ報告」を使ってください。再現に使ったコマンドと、`result.json` の該当部分があると早く直せます
- **新機能の提案**: Issue テンプレート「機能提案」で、背景と困りごとから書いてください。実装方法は後で一緒に考えます

## 開発の流れ

```sh
pnpm install
cp .env.example .env.local     # TypeSafe か Vercel AI Gateway のキーを 1 つ
pnpm test                      # 単体テスト（API は叩きません）
pnpm run typecheck
pnpm dev all                   # 自分の repo を scan する
pnpm dev diff                  # まだ git add していない変更だけを scan する
pnpm dev diff --base origin/main  # このブランチの PR の差分だけを scan する
```

質問文を変えたときは、正しいファイルで確率が下がり、わざと壊したファイルで上がることを両方確かめてください。片側だけ見ると、本物も取りこぼす文になっていることに気づけません。確率は回ごとに ±0.1 ほど揺れるので、閾値付近の値は複数回見てください。

## Pull Request

- 1 つの PR は 1 つの目的に絞り、300 行以内を目安にしてください
- コードにコメントは書かず、「なぜそうしたか」はコミットメッセージに書いてください。何をしているかはコードで分かるようにします
- `pnpm test` と `pnpm run typecheck` が通っていることを確認してください

## 連絡先

質問や相談は GitHub の Issue にお願いします。個人のメールや SNS の DM は見落とすので使わないでください。

## 行動規範

参加するすべての人に [行動規範](CODE_OF_CONDUCT.md) が適用されます。
