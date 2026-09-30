/** --doctor: print the full auto-detection diagnosis without the TUI.
 *
 * Shows, per candidate server: extraction result (with the masked token for
 * correlating with the server's session list), verification result, and the
 * server-side session lifetime — so an expired/short SSO session is visible
 * directly from whichever machine runs it.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { allDesktopServers, extractDesktopToken, maskToken, describeVerifyFailure } from './desktop';
import { Mattermost, type SessionInfo } from './mattermost';

const APP_SUPPORT = join(homedir(), 'Library/Application Support/Mattermost');

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** Server login methods from the public client config — explains why re-login needs the IdP. */
async function loginMethods(server: string): Promise<string> {
  try {
    const r = await fetch(`${server}/api/v4/config/client?format=old`);
    if (!r.ok) return `不明 (HTTP ${r.status})`;
    const c = (await r.json()) as Record<string, unknown>;
    const methods: [string, string][] = [
      ['Email', 'EnableSignInWithEmail'],
      ['Username', 'EnableSignInWithUsername'],
      ['LDAP', 'EnableLdap'],
      ['SAML', 'EnableSaml'],
      ['GitLab', 'EnableSignUpWithGitLab'],
    ];
    const on = methods.filter(([, k]) => c[k] === true || c[k] === 'true').map(([n]) => n);
    return on.length ? on.join(' / ') : '不明';
  } catch {
    return '不明';
  }
}

export async function runDoctor(): Promise<number> {
  console.log(`platform: ${process.platform}`);
  if (process.platform !== 'darwin') {
    console.log('macOSではないため自動検出は無効です（ヘッドレス --token を使用してください）');
    return 1;
  }
  console.log(`config.json: ${existsSync(join(APP_SUPPORT, 'config.json')) ? 'あり' : 'なし'}`);
  console.log(`Cookies DB: ${existsSync(join(APP_SUPPORT, 'Cookies')) ? 'あり' : 'なし'}`);

  const servers = allDesktopServers();
  console.log(`候補サーバー: ${servers.length ? servers.join(', ') : '（なし）'}`);
  if (!servers.length) {
    console.log('結論: デスクトップアプリが見つかりません。一度ログインしてから再実行してください');
    return 1;
  }

  let ok: string | null = null;
  for (const server of servers) {
    console.log(`\n[${server}]`);
    console.log(`  サーバーのログイン方式: ${await loginMethods(server)}`);
    const r = extractDesktopToken(server);
    if (!r) {
      console.log('  この環境では自動検出できません');
      continue;
    }
    if ('error' in r) {
      console.log(`  トークン抽出: 失敗 — ${r.error}`);
      continue;
    }
    console.log(`  トークン抽出: OK (${maskToken(r.token)})`);

    const client = new Mattermost(server, r.token);
    try {
      const me = await client.me();
      console.log(`  検証: OK — ${me.username}`);
      ok = ok ?? server;

      // 注: この種のサーバーでは Cookie トークン ≠ Sessions.Id（別形式で保持）なので
      // 接頭辞照合はできず、デスクトップアプリ由来のセッション行で寿命を判断する。
      const sessions = await client.mySessions();
      const fmt = (s: SessionInfo): string => {
        const days = (s.expires_at - Date.now()) / 86400000;
        return `期限 ${iso(s.expires_at)} (残り${Math.max(0, days).toFixed(0)}日)` +
          ` / 最終アクティビティ ${iso(s.last_activity_at)} / ${s.props?.browser ?? '?'}`;
      };
      const relevant = sessions.filter((s) => (s.props?.browser ?? '').startsWith('Desktop App'));
      const shown = relevant.length ? relevant : sessions;
      console.log(`  サーバー側セッション (${sessions.length}件中 デスクトップアプリ ${relevant.length}件):`);
      for (const s of shown) console.log(`    ${fmt(s)}`);
      if (relevant.some((s) => s.expires_at < Date.now() + 86400000))
        console.log('  ⚠ デスクトップアプリのセッションがまもなく失効/失効済みです');
    } catch (e) {
      console.log(`  検証: 失敗 — ${describeVerifyFailure(e)}`);
    }
  }

  console.log(`\n結論: ${ok ? `${ok} が利用可能` : '利用可能なセッションなし'}`);
  return ok ? 0 : 1;
}
