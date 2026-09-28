#!/usr/bin/env bun
/**
 * mattermost-exporter — export a Mattermost channel (posts JSON + attachments).
 *
 * TUI (default):  mattermost-exporter [--out DIR]
 * Headless:       mattermost-exporter --server URL --token TOKEN --channel-id ID [--out DIR]
 *                 mattermost-exporter --auto-token --server URL --channel-id ID
 */
import { runTui } from './ui';
import { Mattermost } from './mattermost';
import { exportChannel } from './exporter';
import { extractDesktopToken } from './desktop';

const HELP = `mattermost-exporter — Mattermost チャンネルエクスポート (JSON + 添付ファイル)

使い方:
  mattermost-exporter [オプション]

オプション:
  --out DIR            出力先ディレクトリ (デフォルト: ./mattermost-export)
  --server URL         サーバー URL (ヘッドレスモード)
  --token TOKEN        アクセストークン (ヘッドレスモード)
  --channel-id ID      チャンネル ID (ヘッドレスモード)
  --auto-token         デスクトップアプリからトークン自動検出 (macOS, --server と併用)
  -h, --help           このヘルプ

例:
  # 対話モード (macOS ならデスクトップアプリのトークンを自動検出)
  mattermost-exporter

  # ヘッドレス
  mattermost-exporter --server https://mattermost.example.com \\
      --token XXXX --channel-id abc123 --out ./export

  # トークン自動検出でヘッドレス
  mattermost-exporter --auto-token --server https://mattermost.example.com --channel-id abc123

出力:
  <out>/<チャンネル名>-<ID先頭8字>/channel.json   投稿・ユーザー・チャンネル情報
  <out>/<チャンネル名>-<ID先頭8字>/attachments/   添付ファイル (日付_ID_元ファイル名)
`;

function fmtBytes(n: number): string {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

interface Flags {
  out?: string;
  server?: string;
  token?: string;
  channelId?: string;
  autoToken?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = {};
  const args = [...argv];
  const takeValue = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v && !v.startsWith('--') ? v : undefined;
  };
  const takeBool = (name: string): boolean => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return false;
    args.splice(i, 1);
    return true;
  };
  f.out = takeValue('out');
  f.server = takeValue('server');
  f.token = takeValue('token');
  f.channelId = takeValue('channel-id');
  f.autoToken = takeBool('auto-token');
  f.help = takeBool('help') || args.includes('-h');
  return f;
}

const flags = parseArgs(process.argv.slice(2));
if (flags.help) {
  console.log(HELP);
  process.exit(0);
}

const outDir = flags.out ?? './mattermost-export';

async function headless(): Promise<void> {
  const server = flags.server?.replace(/\/+$/, '');
  if (!server) {
    console.error('エラー: --server が必要です (ヘッドレスモード)');
    process.exit(1);
  }
  let token = flags.token;
  if (!token && flags.autoToken) {
    const r = extractDesktopToken(server);
    if (!r || 'error' in r) {
      console.error(
        `エラー: トークン自動検出に失敗 — ${r && 'error' in r ? r.error : 'デスクトップアプリが見つかりません'}`,
      );
      process.exit(1);
    }
    token = r.token;
  }
  if (!token || !flags.channelId) {
    console.error('エラー: --token と --channel-id が必要です');
    process.exit(1);
  }

  const client = new Mattermost(server, token);
  const me = await client.verify().catch((e) => {
    console.error(`エラー: 接続失敗 — ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
  console.log(`接続: ${me.username} @ ${server}`);

  const summary = await exportChannel(client, flags.channelId, outDir, (p) => {
    if (p.phase === 'posts') {
      process.stdout.write(`\r投稿を取得中... ${p.postsFetched}件`);
    } else if (p.phase === 'files') {
      process.stdout.write(`\r添付 ${p.filesDone}/${p.filesTotal} ${p.currentFile ?? ''}`);
    }
  });
  console.log('');
  console.log(`✓ ${summary.channelName}: ${summary.postCount}件の投稿・${summary.fileCount}件の添付 (${fmtBytes(summary.bytes)})`);
  if (summary.dateRange) console.log(`  期間: ${summary.dateRange.from} 〜 ${summary.dateRange.to}`);
  console.log(`  出力先: ${summary.outDir}`);
  if (summary.failedFiles.length) {
    console.warn(`  ⚠ 失敗したファイル: ${summary.failedFiles.join(', ')}`);
  }
}

if (flags.server && (flags.token || (flags.autoToken && flags.server)) && flags.channelId) {
  await headless();
} else {
  await runTui(outDir);
}
