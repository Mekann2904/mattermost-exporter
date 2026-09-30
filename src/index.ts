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
import { exportChannel, fmtBytes } from './exporter';
import { extractDesktopToken, describeVerifyFailure, maskToken } from './desktop';

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

interface Flags {
  out?: string;
  server?: string;
  token?: string;
  channelId?: string;
  autoToken?: boolean;
  help?: boolean;
}

/** Parse argv into flags, reporting malformed/unknown args instead of silently ignoring them. */
function parseArgs(argv: string[]): { flags: Flags; errors: string[] } {
  const flags: Flags = {};
  const errors: string[] = [];
  const args = [...argv];

  const takeValue = (name: string, set: (v: string) => void): void => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return;
    const v = args[i + 1];
    if (!v || v.startsWith('--')) {
      errors.push(`--${name} には値が必要です`);
      args.splice(i, 1);
    } else {
      set(v);
      args.splice(i, 2);
    }
  };
  const takeBool = (name: string): boolean => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return false;
    args.splice(i, 1);
    return true;
  };

  takeValue('out', (v) => (flags.out = v));
  takeValue('server', (v) => (flags.server = v));
  takeValue('token', (v) => (flags.token = v));
  takeValue('channel-id', (v) => (flags.channelId = v));
  flags.autoToken = takeBool('auto-token');
  flags.help = takeBool('help');
  const h = args.indexOf('-h');
  if (h !== -1) {
    flags.help = true;
    args.splice(h, 1);
  }

  for (const leftover of args) errors.push(`不明なオプションです: ${leftover}`);
  return { flags, errors };
}

/** Headless export: validate precisely, then run. */
async function headless(flags: Flags, outDir: string): Promise<void> {
  const { server, channelId, token } = flags;
  if (!server || !channelId || (!token && !flags.autoToken)) {
    const missing = [
      !server && '--server',
      !channelId && '--channel-id',
      !token && !flags.autoToken && '--token または --auto-token',
    ]
      .filter(Boolean)
      .join(' と ');
    console.error(`エラー: ヘッドレスモードには ${missing} が必要です`);
    process.exit(1);
  }

  let resolved = token;
  if (!resolved) {
    const r = extractDesktopToken(server);
    if (!r || 'error' in r) {
      console.error(
        `エラー: トークン自動検出に失敗 — ${r && 'error' in r ? r.error : 'デスクトップアプリが見つかりません'}`,
      );
      process.exit(1);
    }
    resolved = r.token;
  }

  const client = new Mattermost(server, resolved);
  const me = await client.me().catch((e) => {
    console.error(`エラー: ${describeVerifyFailure(e)}`);
    if (flags.autoToken) console.error(`  自動検出トークン: ${maskToken(resolved)}`);
    process.exit(1);
  });
  console.log(`接続: ${me.username} @ ${server}`);

  const summary = await exportChannel(client, channelId, outDir, (p) => {
    if (p.phase === 'posts') {
      process.stdout.write(`\r投稿を取得中... ${p.postsFetched}件`);
    } else {
      process.stdout.write(`\r添付 ${p.filesDone}/${p.filesTotal} ${p.currentFile ?? ''}`);
    }
  });
  console.log('');
  console.log(
    `✓ ${summary.channelName}: ${summary.postCount}件の投稿・${summary.fileCount}件の添付 (${fmtBytes(summary.bytes)})`,
  );
  if (summary.dateRange) console.log(`  期間: ${summary.dateRange.from} 〜 ${summary.dateRange.to}`);
  console.log(`  出力先: ${summary.outDir}`);
  if (summary.failedFiles.length) {
    console.warn(`  ⚠ 失敗したファイル: ${summary.failedFiles.join(', ')}`);
  }
}

const { flags, errors } = parseArgs(process.argv.slice(2));
if (flags.help) {
  console.log(HELP);
  process.exit(0);
}
if (errors.length) {
  for (const e of errors) console.error(`エラー: ${e}`);
  console.error('ヘルプを参照: mattermost-exporter --help');
  process.exit(1);
}

const outDir = flags.out ?? './mattermost-export';
// Any headless flag selects headless mode; missing ones are reported by headless() itself.
const wantsHeadless = Boolean(flags.server || flags.token || flags.channelId || flags.autoToken);
if (wantsHeadless) {
  await headless(flags, outDir);
} else {
  await runTui(outDir);
}
