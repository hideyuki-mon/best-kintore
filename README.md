# ベスト筋トレ

**そのときの条件に合った筋トレメニューを提示するスマホアプリ**を、友人と GitHub で共同開発するリポジトリです。

最優先する価値は **健康・長く続くこと** です。

## 何を作るか（概要）

- 条件（例：**自宅かジムか**、**使える器具**、**使いたい時間** など）から、適したメニューを提示する。
- **ジム**：店舗の検索・登録。店舗に紐づく器具情報を参照し、その条件でメニューを組めるようにする（詳細は [docs/product.md](docs/product.md)）。

## デモ（ブラウザ）

ネイティブアプリの前段として、[demo/](demo/) に **Vite + React** の画面デモがあります（狭い幅想定の UI・日本語）。ローカルで次を実行し、ブラウザで **http://127.0.0.1:5173/** を開いてください。

```bash
cd demo
npm install
npm run dev
```

種目データはデモ用の少量サンプルです。あとから Expo 等へ置き換える前提のたたき台です。

## GitHub 上の名前について

リポジトリ URL 用の名前は英数字とハイフンが無難です（例: `best-kintore`）。  
画面や説明文では「ベスト筋トレ」と表記して問題ありません。

## リポジトリの使い方

| 場所 | 役割 |
|------|------|
| この README | プロジェクトの入口 |
| [docs/product.md](docs/product.md) | プロダクト方針・スコープ |
| [docs/decisions.md](docs/decisions.md) | 二人で「こう決めた」という合意だけを日付付きで残す |
| **Issues** | 仕様・技術スタック・画面の議論（テンプレ「前提・振り返り」あり） |

## Git がはじめての場合

1. [GitHub](https://github.com) でアカウントを用意する。
2. リポジトリを **clone** するか、[GitHub Desktop](https://desktop.github.com/) でこのリポジトリを開く。
3. 変更を **commit** して **push** する（Desktop なら「Commit to main」→「Push origin」）。

コマンドで remote を自分用に差し替える例:

```bash
git clone https://github.com/<ユーザー名>/best-kintore.git
cd best-kintore
```

友人を **Settings → Collaborators** から招待すると、共同編集できます。

## 最初に開くとよい Issue

- **技術**: スマホ向けフレームワーク（Expo / React Native / Flutter など）の候補と MVP 範囲
- **データ**: 店舗・器具マスタの第1版（静的 JSON から始めるか、BaaS か）

Issue テンプレート「前提・振り返り」から作成できます。
