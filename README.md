# talkingclaw

アニメ声の彼女キャラ agent「クロエ」と、テキストではなく喋りながらコーディングできるツール。

- **声**: [AivisSpeech](https://aivis-project.com/)(ローカル・無料)— まお あまあま
- **頭脳**: Claude Agent SDK(Claude Code のログイン認証を継承、API key 不要)
- **言語**: 日本語

## 必要環境

- macOS(音声再生に `afplay` を使用)
- Node.js >= 23.6(TypeScript 直接実行)
- [AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine/releases) を `engine/macOS-x64/` に展開(起動は不要 — 落ちていたら `npm start` が自動起動する)
- Claude Code にログイン済みであること

## 使い方

```sh
npm install
npm run web      # ブラウザ UI (http://localhost:3300)。🎤 でハンズフリー音声会話(Chrome 推奨)
npm start        # テキスト入力の会話 CLI
npm run smoke    # 非対話スモーク(疎通 → 2往復 → 音声再生)
```

ブラウザ UI は Web Speech API で音声認識するので Chrome を推奨。
返答は文単位でストリーム再生され、待ち時間には相槌が入る。

`exit` または Ctrl+C で終了。

## 設定

[src/config.ts](src/config.ts) でキャラ名・persona・話者 ID・話速・モデルを変更できる。
話者一覧は engine 起動中に `curl http://127.0.0.1:10101/speakers` で確認。

## ロードマップ

1. ~~Wave 1: テキスト入力 → アニメ声返答の会話 CLI~~
2. ~~Wave 2: ブラウザ UI + Web Speech API で音声入力(ハンズフリー会話)~~
3. Wave 3: coding agent 統合(声で指示 → 実コード編集、進捗を声で実況)
4. Wave 4: 記憶・キャラ設定拡充・アバター

## クレジット

音声合成: [AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine)(音声モデル: まお)。
利用時は AivisHub 掲載の各音声モデルの利用規約に従うこと。
