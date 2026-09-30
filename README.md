# mattermost-exporter

Mattermost のチャンネルを、投稿と添付ファイルごとエクスポートするツールです。

## 実行方法

[Releases](https://github.com/Mekann2904/mattermost-exporter/releases) から自分の環境に合うバイナリをダウンロードして実行します（ランタイム同梱の単一実行ファイル）。インストールは不要です。対話モードは macOS 専用で、Linux ではヘッドレスモード（`--token`）を使います。

| バイナリ | 環境 |
| --- | --- |
| `mattermost-exporter-darwin-arm64` | macOS / Apple Silicon（対話モード対応） |
| `mattermost-exporter-darwin-x64` | macOS / Intel（対話モード対応） |
| `mattermost-exporter-linux-x64` | Linux x86_64（ヘッドレスモード） |
| `mattermost-exporter-linux-arm64` | Linux arm64（ヘッドレスモード） |

```sh
chmod +x mattermost-exporter-darwin-arm64
xattr -d com.apple.quarantine mattermost-exporter-darwin-arm64  # 初回のみ・macOS (Gatekeeper対策)
./mattermost-exporter-darwin-arm64                  # 対話モードで起動
./mattermost-exporter-darwin-arm64 --out ~/exports  # 出力先を指定する場合
```

## 対話モードの流れ

起動すると、ログイン、チャンネル選択、エクスポートの順に画面が進みます。

### ログイン

- **macOS + Mattermost デスクトップアプリ**：ログイン済みセッションを自動検出します（初回のみ macOS の許可ダイアログが出ます。その場で「常に許可」を選ぶと次回から出ません）
- **Linux**：対話モードは使えないため、ヘッドレスモード（`--server` + `--token`）を使用してください


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
| `--doctor` | 自動検出の全段階（抽出・検証・サーバー側セッション期限）を診断表示 |
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

## 開発

bun があれば nix は不要です:

```sh
bun install           # 依存取得
bun test              # 単体テスト
bun run typecheck     # 型チェック
bun src/index.ts      # TUI 実行
```

nix がある場合は `nix develop` で bun の入った開発シェルに入れます（flake.nix）。

### リリースビルド

配布用バイナリは CI が `v*` タグの push で自動ビルドして Release にアップロードします（darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64。`.github/workflows/release.yml`）。ローカルでの `bun build --compile` は開発確認用に留めてください — nix の bun でビルドすると `/nix/store` の ICU 依存が埋め込まれ、nix のない環境で dyld エラーになるため配布には使えません。

## ライセンス

MIT
