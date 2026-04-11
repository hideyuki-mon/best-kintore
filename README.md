# ベスト筋トレ

友人と一緒に、「健康・長く続くこと」を最優先した筋トレの考え方・メニュー・振り返りを整理するリポジトリです。

## GitHub 上の名前について

GitHub の **Repository name**（URL に使われる部分）は英数字とハイフンが無難です。例: `best-kintore`  
表示はこの README のタイトルや、リポジトリページの **About** の説明文で「ベスト筋トレ」と書けば問題ありません。

## このリポジトリの使い方（ざっくり）

| 場所 | 役割 |
|------|------|
| この README | 目的と全体の案内 |
| [docs/decisions.md](docs/decisions.md) | 二人で「こう決めた」という合意だけを日付付きで残す |
| **Issues** | 議論・提案・週の振り返り（ラベル例: `前提` `メニュー` `振り返り`） |

## Git がはじめての場合（最短ルート）

1. [GitHub](https://github.com) でアカウントを作り、**New repository** で空のリポジトリを作成する（名前は例: `best-kintore`）。
2. 次のどちらかがおすすめです。
   - **[GitHub Desktop](https://desktop.github.com/)** を入れて「Add」→ このフォルダを選び、Publish でリポジトリに載せる（画面操作が中心）。
   - または PC に [Git for Windows](https://git-scm.com/download/win) を入れたうえで、ターミナルでこのフォルダに移動して次を実行する。

```bash
git init
git add .
git commit -m "最初のコミット: README とテンプレ"
git branch -M main
git remote add origin https://github.com/<あなたのユーザー名>/best-kintore.git
git push -u origin main
```

`<あなたのユーザー名>` とリポジトリ名は、GitHub で作ったものに合わせてください。

友人を **Collaborator** に招待すると、同じリポジトリで Issue や編集ができます（リポジトリの **Settings → Collaborators**）。

## 最初に開くとよい Issue

タイトル例: **前提：トレ環境・時間・週回数を決める**  
テンプレート「前提・振り返り」から作ると、本文の項目が自動で入ります。
