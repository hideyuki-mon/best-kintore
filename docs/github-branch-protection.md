# Branch Protection の運用

`main` を直接書き換えず、**プルリクエスト（PR）とレビュー**を通して変更するための手順です。設定は GitHub の画面上で行います（リポジトリ内のファイルだけでは有効になりません）。

## 前提

- 対象リポジトリの **Settings** を変更できる権限（通常はオーナー、または **Admin** のコラボレーター）があること。

## 推奨する方針（二人開発向け）

| 項目 | 推奨 |
|------|------|
| 対象ブランチ | `main`（デフォルトブランチ名が違う場合はその名前） |
| PR 必須 | オン（`main` へは PR 経由のみ） |
| 承認人数 | **1**（相手1人の承認でマージ可能。自分の PR は自分では承認できない） |
| フォースプッシュ | ブロック |
| ステータスチェック必須 | 現状 CI が無いため**オフ**で開始。GitHub Actions 等を追加したあと、ジョブ名と一致させてオンにできる |

## 手順 A: Rulesets（ルールセット）

GitHub が案内することが多い **Repository rules** です。

1. GitHub でリポジトリを開く。
2. **Settings**（設定）→ 左メニュー **Rules**（ルール）→ **Rulesets**（ルールセット）→ **New ruleset** → **New branch ruleset**。
3. **Ruleset name**: 例 `Protect main`。
4. **Enforcement status**: **Active**。
5. **Target branches**: **Add target** → **Include default branch**、または **Include by pattern** で `main`。
6. **Branch rules** で次を有効化する。
   - **Require a pull request before merging**（マージ前に PR を必須にする）
     - サブオプションで **Required approvals** を **1**。
   - **Block force pushes**（強制 push の禁止）
   - （任意）**Require conversation resolution before merging**（未解決のレビューコメントがあるとマージできない）
7. 保存する。

管理者も例外なく守りたい場合は、該当ルールに **Do not bypass** 相当（「バイパスを許可しない」）があれば有効にする。UI は更新されることがあるため、表示名が少し違っても同種の項目を探す。

## 手順 B: Classic の Branch protection rules

従来の **Branches** 画面から設定する方法です。

1. **Settings** → **Branches**。
2. **Branch protection rules** で **Add branch protection rule**（または **Add rule**）。
3. **Branch name pattern** に `main`。
4. 次をオンにする（表示名は環境で多少異なる場合があります）。
   - **Require a pull request before merging**
   - **Require approvals** を **1**
   - **Do not allow bypassing the above settings** をオンにし、**Include administrators** もオンにすると、管理者もルールの対象にできる
   - **Block force pushes**
5. 保存する。

## マージ後の運用

- 作業用ブランチを切る → コミットして push → **PR を作成** → レビュー依頼 → 承認後にマージ、が基本形です。
- **Auto merge** を使う場合は、PR 画面で有効化し、承認とチェックが揃うと自動マージされます。保護ルールを満たさない限りマージされません。

## つまずいたとき

| 現象 | 確認すること |
|------|----------------|
| マージボタンが出ない | 承認数が足りない、未解決コメント、ドラフト PR など |
| 「Required status checks が失敗」と出る | 必須チェックに指定した名前と、実際の CI ジョブ名が一致しているか。CI が無いのに必須にしているとマージできない |
| 緊急でどうしても直したい | 一時的に Admin がルールを緩める、または別ブランチで直して PR にする（後者を推奨） |

## GitHub CLI で同じ Ruleset を再現する

[GitHub CLI](https://cli.github.com/)（`gh`）が入っており `gh auth login` 済みなら、API でルールセットを作成できます（`<owner>` / `<repo>` を置き換える）。

```bash
gh api repos/<owner>/<repo>/rulesets --method POST --input - <<'EOF'
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main"],
      "exclude": []
    }
  },
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    { "type": "non_fast_forward" }
  ]
}
EOF
```

デフォルトブランチ名が `main` でない場合は、`include` を `refs/heads/<ブランチ名>` に合わせるか、GitHub の Ruleset 画面で使えるデフォルトブランチ指定に読み替える。

上記は Bash のヒアドキュメント例です。Windows PowerShell では JSON をファイルに保存してから `Get-Content .\ruleset.json -Raw | gh api repos/<owner>/<repo>/rulesets --method POST --input -` のように渡すとよいです。

## 参考（公式）

- [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
