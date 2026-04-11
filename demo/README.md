# ベスト筋トレ · 画面デモ

リポジトリ本体（スマホアプリ方針）の **操作フロー確認用** です。Vite + React + TypeScript。

## 起動

```bash
npm install
npm run dev
```

ブラウザで表示された URL（通常は `http://127.0.0.1:5173/`）を開きます。

## 内容

- 自宅／ジム、ジムの検索・登録（デモ）、時間 → 条件に合う種目の一覧（簡易フィルタ）
- 初期ジムは **ジェクサー（Jexer）系の掲載47件相当**（[FIT Search ジェクサー一覧](https://fitsearch.jp/group/jexer)＋各店公式情報を基にした住所）。**器具タグはデモ用**で実設備と一致しません。

## ビルド

```bash
npm run build
```

生成物は `dist/`（`.gitignore` 済み）。
