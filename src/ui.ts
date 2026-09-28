/** OpenTUI interface: auth -> channel select -> export progress. */
import {
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  SelectRenderable,
  InputRenderableEvents,
  SelectRenderableEvents,
  createCliRenderer,
} from '@opentui/core';
import { Mattermost } from './mattermost';
import type { Channel } from './mattermost';
import { exportChannel, type ExportSummary } from './exporter';
import { desktopServerList, extractDesktopToken } from './desktop';

type Renderer = Awaited<ReturnType<typeof createCliRenderer>>;

const C = {
  accent: '#7AA2F7',
  text: '#C0CAF5',
  muted: '#565F89',
  ok: '#9ECE6A',
  warn: '#E0AF68',
  err: '#F7768E',
};

function txt(r: Renderer, content: string, fg = C.text): TextRenderable {
  return new TextRenderable(r, { content, fg });
}

function clearRoot(r: Renderer): void {
  for (const child of [...r.root.getChildren()]) {
    child.destroyRecursively();
  }
}

function frame(r: Renderer, title: string): BoxRenderable {
  const page = new BoxRenderable(r, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    borderStyle: 'rounded',
    borderColor: C.accent,
    title: ` mattermost-exporter — ${title} `,
    padding: 1,
    gap: 1,
  });
  r.root.add(page);
  return page;
}

function typeBadge(ch: Channel): string {
  if (ch.type === 'P') return '🔒';
  if (ch.type === 'D') return '👤';
  return '#';
}

function fmtBytes(n: number): string {
  if (n > 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function progressBar(done: number, total: number, width = 36): string {
  if (total <= 0) return '';
  const filled = Math.round((done / total) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${done}/${total}`;
}

function formatSummary(s: ExportSummary): string {
  return `${s.postCount}件の投稿・${s.fileCount}件の添付 (${fmtBytes(s.bytes)})${
    s.dateRange ? ` ${s.dateRange.from}〜${s.dateRange.to}` : ''
  }`;
}

export async function runTui(outDir: string): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });

  const showManual = (initialError?: string): void => {
    clearRoot(renderer);
    const page = frame(renderer, '接続設定');
    if (initialError) page.add(txt(renderer, `⚠ ${initialError}`, C.warn));
    page.add(txt(renderer, 'サーバー・ログインID・パスワードを入力してください（トークン不要）', C.muted));

    page.add(txt(renderer, 'サーバー URL:', C.text));
    const serverInput = new InputRenderable(renderer, {
      width: 50,
      placeholder: 'https://mattermost.example.com',
      textColor: C.text,
      focusedBackgroundColor: '#24283B',
    });
    const servers = desktopServerList();
    if (servers[0]) serverInput.value = servers[0];
    page.add(serverInput);

    page.add(txt(renderer, 'ログインID (メールアドレス or ユーザー名):', C.text));
    const idInput = new InputRenderable(renderer, {
      width: 50,
      placeholder: 'e.g. you@example.com',
      textColor: C.text,
      focusedBackgroundColor: '#24283B',
    });
    page.add(idInput);

    page.add(txt(renderer, 'パスワード:', C.text));
    const passInput = new InputRenderable(renderer, {
      width: 50,
      placeholder: '********',
      textColor: C.text,
      focusedBackgroundColor: '#24283B',
    });
    page.add(passInput);

    const status = txt(renderer, 'Enter で次へ ・ パスワード入力後に Enter でログイン', C.muted);
    page.add(status);

    serverInput.focus();

    const connect = async (): Promise<void> => {
      const server = String(serverInput.value ?? '').trim().replace(/\/+$/, '');
      const loginId = String(idInput.value ?? '').trim();
      const password = String(passInput.value ?? '');
      if (!/^https?:\/\//.test(server)) {
        status.content = '✗ URL は https:// で始めてください';
        status.fg = C.err;
        return;
      }
      if (!loginId || !password) {
        status.content = '✗ ログインIDとパスワードを入力してください';
        status.fg = C.err;
        return;
      }
      status.content = 'ログイン中...';
      status.fg = C.warn;
      try {
        const { client, me } = await Mattermost.login(server, loginId, password);
        await showChannels(client, `${me.username} @ ${server}`);
      } catch (e) {
        status.content = `✗ ログイン失敗: ${e instanceof Error ? e.message.slice(0, 90) : e}`;
        status.fg = C.err;
      }
    };

    serverInput.on(InputRenderableEvents.ENTER, () => {
      idInput.focus();
    });
    idInput.on(InputRenderableEvents.ENTER, () => {
      passInput.focus();
    });
    passInput.on(InputRenderableEvents.ENTER, () => {
      void connect();
    });
  };

  const showChannels = async (client: Mattermost, who: string): Promise<void> => {
    clearRoot(renderer);
    const page = frame(renderer, 'チャンネル選択');
    const status = txt(renderer, `✓ ${who} — チャンネル一覧を取得中...`, C.ok);
    page.add(status);

    let channels: Channel[];
    try {
      channels = await client.allChannels();
    } catch (e) {
      showManual(`✗ チャンネル取得失敗: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      return;
    }
    if (!channels.length) {
      status.content = '✗ 参加しているチャンネルがありません';
      status.fg = C.err;
      return;
    }
    channels.sort((a, b) => (b.last_post_at ?? 0) - (a.last_post_at ?? 0));
    status.content = `✓ ${who} — ${channels.length} チャンネル ↑↓ で移動、Enter でエクスポート、q で終了`;

    const select = new SelectRenderable(renderer, {
      width: 70,
      height: 20,
      options: channels.map((ch) => ({
        name: `${typeBadge(ch)} ${ch.display_name || ch.name}`,
        description: ch.last_post_at
          ? `最終投稿 ${new Date(ch.last_post_at).toISOString().slice(0, 10)} ・ ${ch.total_msg_count ?? '?'}件`
          : '投稿なし',
        value: ch.id,
      })),
      showDescription: true,
      showScrollIndicator: true,
    });
    select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
      const ch = channels.find((c) => c.id === option?.value);
      if (ch) void showExport(client, ch);
    });
    select.focus();
    page.add(select);
  };

  const showExport = async (client: Mattermost, ch: Channel): Promise<void> => {
    clearRoot(renderer);
    const page = frame(renderer, `エクスポート: ${ch.display_name}`);
    const line1 = txt(renderer, '投稿を取得中...', C.text);
    const line2 = txt(renderer, '', C.muted);
    const line3 = txt(renderer, '', C.accent);
    const line4 = txt(renderer, '', C.muted);
    page.add(line1);
    page.add(line2);
    page.add(line3);
    page.add(line4);

    try {
      const summary = await exportChannel(client, ch.id, outDir, (p) => {
        if (p.phase === 'posts') {
          line1.content = `投稿を取得中... ${p.postsFetched}件`;
        } else if (p.phase === 'files') {
          line1.content = `✓ 投稿 ${p.postsFetched}件を取得済み`;
          line2.content = `添付ファイルをダウンロード中...`;
          line3.content = progressBar(p.filesDone, p.filesTotal);
          line4.content = `  ${p.currentFile ?? ''} (${fmtBytes(p.bytes)})`;
        }
      });
      line1.content = `✓ 完了: ${formatSummary(summary)}`;
      line1.fg = C.ok;
      line2.content = `出力先: ${summary.outDir}`;
      line3.content = summary.failedFiles.length
        ? `⚠ 失敗: ${summary.failedFiles.join(', ').slice(0, 100)}`
        : '';
      line3.fg = summary.failedFiles.length ? C.warn : C.muted;
      line4.content = 'q: 終了';
    } catch (e) {
      line1.content = `✗ エクスポート失敗: ${e instanceof Error ? e.message.slice(0, 120) : e}`;
      line1.fg = C.err;
      line4.content = 'q: 終了';
    }
    renderer.keyInput.on('keypress', (key) => {
      if (key.name === 'q') {
        renderer.destroy();
        process.exit(0);
      }
    });
  };

  // ---- boot: try desktop token first ----
  const page = frame(renderer, '起動');
  const status = txt(renderer, 'Mattermost デスクトップアプリのセッションを確認中...', C.muted);
  page.add(status);

  await new Promise((r) => setTimeout(r, 50));
  const detectErrors: string[] = []
  if (process.platform === 'darwin' && desktopServerList().length > 0) {
    for (const server of desktopServerList()) {
      status.content = `デスクトップアプリのセッション確認中... ${server}`;
      const result = extractDesktopToken(server);
      if (!result) continue;
      if ('error' in result) {
        detectErrors.push(`${server}: ${result.error}`);
        continue;
      }
      const client = new Mattermost(server, result.token);
      try {
        const me = await client.verify();
        status.content = `✓ トークンを検出: ${me.username} @ ${server}`;
        status.fg = C.ok;
        await new Promise((r2) => setTimeout(r2, 400));
        await showChannels(client, `${me.username} @ ${server}`);
        return;
      } catch {
        detectErrors.push(`${server}: セッションが無効です（デスクトップアプリで再ログインしてください）`);
      }
    }
  }
  const why = detectErrors.length ? detectErrors[0] : 'デスクトップアプリが見つかりません';
  status.content = `✗ 自動検出失敗 → ID/パスワードでログインします`;
  status.fg = C.warn;
  await new Promise((r) => setTimeout(r, 800));
  showManual(`自動検出できませんでした — ${why}`);
}
