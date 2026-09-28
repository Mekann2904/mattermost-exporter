# mattermost-exporter

Mattermost チャンネルを **投稿JSON + 添付ファイル** としてエクスポートするツール。OpenTUI によるターミナルUI付き。

```
┌ mattermost-exporter — チャンネル選択 ┐
│ ✓ you @ https://… — 12 チャンネル │
│ # daily-235737C      最終投稿 2026-09-28 │
│ # town-square        最終投稿 2026-09-27 │
│ …                                     │
└───────────────────────────────────────┘
```

## 特徴

- **TUIモード**: チャンネル一覧から選んでエクスポート。進捗バー・添付ファイルのダウンロード状況をライブ表示
- **トークン自動検出 (macOS)**: Mattermost デスクトップアプリのセッションを再利用 — ログイン不要（Keychainの許可ダイアログが出ます）
- **ヘッドレスモード**: フラグのみで完結。CI・スクリプト向け
- 出力: `<チャンネル名>-<ID>/channel.json`（投稿・ユーザー・チャンネル情報）+ `attachments/`（`日付_ID_元ファイル名`）

## 使い方（利用者・nix不要）

配布バイナリ（単一実行ファイル、Bunランタイム同梱）をダウンロードして実行するだけ。インストール不要:

```sh
./mattermost-exporter                      # TUIモード
./mattermost-exporter --out ~/exports      # 出力先を指定
```

ヘッドレス:

```sh
mattermost-exporter \
  --server https://mattermost.example.com \
  --token <personal-access-token> \
  --channel-id <channel-id> \
  --out ./export

# macOS でトークン自動検出 (--token 省略可)
mattermost-exporter --auto-token \
  --server https://mattermost.example.com \
  --channel-id <channel-id>
```

チャンネルIDは Mattermost UI のチャンネル情報から確認できます（プロフィール → チャンネル管理 / URL末尾の文字列）。

## 開発（nix）

```sh
nix develop          # bun の入った開発シェル
bun src/index.ts     # TUI 実行
bun x tsc --noEmit   # 型チェック

nix build            # 単一バイナリを ./result/bin/mattermost-exporter に生成
nix run              # そのまま実行
```

`nix build` は `bun build --compile` で自己完結バイナリを生成します。依存は `bun.lock` → `bun.nix`（コミット）経由で [bun2nix](https://github.com/nix-community/bun2nix) が取得するため、ビルドは hermetic で `node_modules` は git管理外です。

### 依存を更新するとき

```sh
nix develop -c bash -c 'bun install'                # package.json 変更
nix run github:nix-community/bun2nix -- -o bun.nix  # bun.nix 再生成 → コミット
```

## セキュリティについて

- トークン自動検出はローカルのデスクトップアプリのセッションCookie（Keychainで暗号化されたもの）を読み取るだけで、**どこにも送信しません**
- 出力先にチャンネルの全文と添付ファイルが平文で保存される点に注意してください

## ライセンス

MIT
