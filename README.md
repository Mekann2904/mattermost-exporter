# mattermost-exporter

Mattermost のチャンネルを、投稿と添付ファイルごとエクスポートするツールです。

## 実行方法

[Releases](https://github.com/Mekann2904/mattermost-exporter/releases) から `mattermost-exporter-darwin-arm64`（macOS / Apple Silicon、ランタイム同梱の単一実行ファイル）をダウンロードして実行します。インストールは不要です。

```sh
chmod +x mattermost-exporter-darwin-arm64
xattr -d com.apple.quarantine mattermost-exporter-darwin-arm64  # 初回のみ（Gatekeeper対策）
./mattermost-exporter-darwin-arm64                  # 対話モードで起動
./mattermost-exporter-darwin-arm64 --out ~/exports  # 出力先を指定する場合
```

## 対話モードの流れ

起動すると、ログイン、チャンネル選択、エクスポートの順に画面が進みます。

### ログイン

- **macOS + Mattermost デスクトップアプリ**：ログイン済みセッションを自動検出します（初回のみ macOS の許可ダイアログが出ます。その場で「常に許可」を選ぶと次回から出ません）


## 出力されるもの

```
<出力先>/<チャンネル名>-<ID先頭8字>/
├── channel.json      # 投稿・ユーザー・チャンネル情報 (JSON)
└── attachments/      # 添付ファイル (日付_ID_元ファイル名)
```

## コマンドラインオプション

| オプション | 役割 |
| --- | --- |
| `--out DIR` | 出力先ディレクトリ（デフォルト: `./mattermost-export`） |
| `--server URL` | サーバーURL（ヘッドレスモード） |
| `--token TOKEN` | アクセストークン（ヘッドレスモード） |
| `--auto-token` | デスクトップアプリからトークンを自動検出（macOS。`--server` と併用） |
| `--channel-id ID` | チャンネルID（ヘッドレスモード） |
| `-h`, `--help` | ヘルプを表示 |

### ヘッドレスモード（スクリプトや CI 向け）

対話画面なしでフラグだけで完結します。

```sh
mattermost-exporter \
  --server https://mattermost.example.com \
  --token <personal-access-token> \
  --channel-id <channel-id> \
  --out ./export
```

- `--token` の代わりに `--auto-token`（macOS のデスクトップアプリのセッションを自動検出）
- チャンネルIDは Mattermost のチャンネルURL末尾の文字列で確認できます
- 不足や誤ったフラグを指定すると、その場でエラーが表示されます

## セキュリティについて

- トークン自動検出はローカルのデスクトップアプリのセッションCookie（Keychainで暗号化されたもの）を使用します。

## 開発（nix）

```sh
nix develop          # bun の入った開発シェル
bun install          # 依存取得（グローバルキャッシュで2回目から高速）
bun src/index.ts     # TUI 実行
bun x tsc --noEmit   # 型チェック

# 配布用単一バイナリ生成（「実行方法」のものと同名。リリース時はプラットフォーム名を付ける）
bun build --compile src/index.ts --outfile dist/mattermost-exporter-darwin-arm64
```

## ライセンス

MIT
