/** OpenTUI interface: auth -> channel select -> export progress. */
import {
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  SelectRenderable,
  InputRenderableEvents,
  SelectRenderableEvents,
  createCliRenderer,
  type KeyEvent,
} from '@opentui/core';
import { Mattermost } from './mattermost';
import type { Channel } from './mattermost';
import { exportChannel, fmtBytes, type ExportSummary } from './exporter';
import { desktopServerList, resolveDesktopSession } from './desktop';

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

function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true;
  const t = text.toLowerCase();
  if (t.includes(query)) return true; // substring: always matches
  // fuzzy: all query chars must appear in order (subsequence)
  let i = 0;
  for (const ch of t) {
    if (ch === query[i]) i++;
    if (i >= query.length) return true;
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runTui(outDir: string): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });

  // destroy() tears down renderables but does not stop the process (Ctrl+C / terminating
  // signals); pending async work would then crash touching destroyed renderables. Exit cleanly.
  renderer.on('destroy', () => process.exit(0));

  // Global key handlers belong to the current screen and are removed on every transition,
  // so screens never see each other's keys and nothing accumulates.
  let keyHandlers: Array<(key: KeyEvent) => void> = [];
  const onKey = (name: string, fn: (key: KeyEvent) => void): void => {
    const handler = (key: KeyEvent): void => {
      if (key.name === name) fn(key);
    };
    keyHandlers.push(handler);
    renderer.keyInput.on('keypress', handler);
  };
  const switchScreen = async (screen: () => Promise<void>): Promise<void> => {
    for (const h of keyHandlers) renderer.keyInput.off('keypress', h);
    keyHandlers = [];
    await screen();
  };
  const quit = (): void => {
    renderer.destroy();
    process.exit(0);
  };

  const showManual = async (initialError?: string): Promise<void> => {
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
        await switchScreen(() => showChannels(client, `${me.username} @ ${server}`));
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
      await switchScreen(() => showManual(`✗ チャンネル取得失敗: ${e instanceof Error ? e.message.slice(0, 100) : e}`));
      return;
    }
    if (!channels.length) {
      status.content = '✗ 参加しているチャンネルがありません';
      status.fg = C.err;
      return;
    }
    channels.sort((a, b) => (b.last_post_at ?? 0) - (a.last_post_at ?? 0));

    const optionOf = (ch: Channel) => ({
      name: `${typeBadge(ch)} ${ch.display_name || ch.name}`,
      description: ch.last_post_at
        ? `最終投稿 ${new Date(ch.last_post_at).toISOString().slice(0, 10)} ・ ${ch.total_msg_count ?? '?'}件`
        : '投稿なし',
      value: ch.id,
    });

    const queryInput = new InputRenderable(renderer, {
      width: 68,
      placeholder: '検索… (タイプで絞り込み)',
      textColor: C.text,
      focusedBackgroundColor: '#24283B',
    });
    page.add(queryInput);

    const select = new SelectRenderable(renderer, {
      width: 70,
      height: 18,
      options: channels.map(optionOf),
      showDescription: true,
      showScrollIndicator: true,
    });
    page.add(select);

    let filtered = channels;

    const applyFilter = (): void => {
      const q = String(queryInput.value ?? '').trim().toLowerCase();
      filtered = channels.filter((ch) => fuzzyMatch(`${ch.display_name} ${ch.name}`, q));
      select.options = filtered.map(optionOf);
      select.setSelectedIndex(0);
      status.content = `${filtered.length}/${channels.length} チャンネル — ↑↓ 選択、Enter 決定（入力欄でタイプして絞り込み）`;
    };

    const confirm = (): void => {
      const opt = select.getSelectedOption();
      if (!opt?.value) return;
      const ch = filtered.find((c) => c.id === opt.value);
      if (ch) {
        void switchScreen(() => showExport(client, ch));
      }
    };

    queryInput.on(InputRenderableEvents.CHANGE, applyFilter);
    queryInput.on(InputRenderableEvents.ENTER, confirm);
    select.on(SelectRenderableEvents.ITEM_SELECTED, confirm);

    // Arrows move the list from here (the input keeps focus); preventDefault stops
    // a focused Select from also handling the key and double-stepping.
    onKey('up', (key) => {
      key.preventDefault();
      select.moveUp();
    });
    onKey('down', (key) => {
      key.preventDefault();
      select.moveDown();
    });

    applyFilter();
    queryInput.focus();
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
        } else {
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
    } catch (e) {
      line1.content = `✗ エクスポート失敗: ${e instanceof Error ? e.message.slice(0, 120) : e}`;
      line1.fg = C.err;
    }
    line4.content = 'q: 終了';
    onKey('q', () => quit());
  };

  // ---- boot: env session, then desktop app session, then manual login ----
  const page = frame(renderer, '起動');
  const status = txt(renderer, 'Mattermost デスクトップアプリのセッションを確認中...', C.muted);
  page.add(status);

  await sleep(50); // let the first frame paint before keychain/sqlite work blocks the loop

  const envServer = process.env.MMEX_SERVER;
  const envToken = process.env.MMEX_TOKEN;
  if (envServer && envToken) {
    const client = new Mattermost(envServer, envToken);
    const me = await client.me().catch(() => null);
    if (me) {
      await switchScreen(() => showChannels(client, `${me.username} @ ${envServer}`));
      return;
    }
  }

  const session = await resolveDesktopSession();
  if ('client' in session) {
    status.content = `✓ トークンを検出: ${session.me.username} @ ${session.server}`;
    status.fg = C.ok;
    await sleep(400);
    await switchScreen(() => showChannels(session.client, `${session.me.username} @ ${session.server}`));
    return;
  }
  const why = session.errors[0] ?? 'デスクトップアプリが見つかりません';
  status.content = '✗ 自動検出失敗 → ID/パスワードでログインします';
  status.fg = C.warn;
  await sleep(800);
  await switchScreen(() => showManual(`自動検出できませんでした — ${why}`));
}
