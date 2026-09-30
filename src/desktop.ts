/**
 * Auto-detect the Mattermost session token from the macOS desktop app.
 *
 * The Electron app stores an MMAUTHTOKEN cookie in its Chromium cookie DB,
 * encrypted with a key derived (PBKDF2) from the "Mattermost Safe Storage"
 * password in the macOS Keychain (AES-128-CBC, IV = 16 spaces).
 * Decrypted plaintext comes in two layouts, depending on desktop app version:
 *   new: sha256(host_key)[32 bytes] + token + PKCS7 padding  (cookie integrity MAC)
 *   old: token + PKCS7 padding
 */
import { pbkdf2Sync, createDecipheriv, createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { existsSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mattermost, type Me } from './mattermost';

const APP_SUPPORT = join(homedir(), 'Library/Application Support/Mattermost');

/**
 * Run a read-only query against a private copy of the desktop cookie DB
 * (the live DB may be locked by the running app).
 * Throws when the DB is missing or unreadable; `.get()`'s null ("no row")
 * passes through untouched, keeping technical failure and absence distinct.
 */
function withCookieDb<T>(fn: (db: Database) => T): T {
  const src = join(APP_SUPPORT, 'Cookies');
  if (!existsSync(src)) throw new Error('Cookie DB not found');
  const tmp = join(tmpdir(), `mattermost-exporter-cookies-${process.pid}`);
  try {
    copyFileSync(src, tmp);
    const db = new Database(tmp, { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Server URLs registered in the desktop app (supports both config v4 `servers` and legacy `teams`). */
function desktopServerList(): string[] {
  const cfgPath = join(APP_SUPPORT, 'config.json');
  if (!existsSync(cfgPath)) return [];
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const list = Array.isArray(cfg?.servers) ? cfg.servers : Array.isArray(cfg?.teams) ? cfg.teams : [];
    return list
      .map((t: { url?: string }) => (t.url ?? '').replace(/\/+$/, ''))
      .filter((u: string) => u.length > 0);
  } catch {
    return [];
  }
}

/** Fallback: hosts that have an MMAUTHTOKEN cookie (straight from the cookie DB). */
export function cookieServerList(): string[] {
  try {
    const rows = withCookieDb((db) =>
      db.query(`SELECT DISTINCT host_key FROM cookies WHERE name='MMAUTHTOKEN'`).all() as {
        host_key: string;
      }[],
    );
    return rows.map((r) => `https://${r.host_key.replace(/^\./, '')}`);
  } catch {
    return [];
  }
}

/** All candidate servers (config + cookies, deduplicated). */
export function allDesktopServers(): string[] {
  return [...new Set([...desktopServerList(), ...cookieServerList()])];
}

function keychainPassword(): string | null {
  try {
    const r = Bun.spawnSync(['security', 'find-generic-password', '-s', 'Mattermost Safe Storage', '-w']);
    const out = r.stdout?.toString().trim();
    return out && r.exitCode === 0 ? out : null;
  } catch {
    return null;
  }
}

export type DetectResult = { token: string } | { error: string };

/** Mattermost セッショントークンの形 (通常26文字の印字可能ASCII) */
const TOKEN_RE = /^[\x21-\x7e]{20,40}$/;

/**
 * Decrypt an MMAUTHTOKEN cookie value. Handles both desktop app generations:
 * with and without the 32-byte sha256(host_key) integrity prefix.
 * Returns the token, or null when it does not look like a token.
 */
export function decryptMmAuthCookie(data: Buffer, hostKey: string, pass: string): string | null {
  try {
    const buf = Buffer.from(data);
    if (buf.subarray(0, 3).toString() !== 'v10') return null;
    const key = pbkdf2Sync(pass, 'saltysalt', 1003, 16, 'sha1');
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const pt = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
    const mac = createHash('sha256').update(Buffer.from(hostKey, 'latin1')).digest();
    const body = pt.length >= 32 && pt.subarray(0, 32).equals(mac) ? pt.subarray(32) : pt;
    const token = body.toString('latin1').replace(/[\x01-\x10]+$/, '');
    return TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** An MMAUTHTOKEN cookie row from the desktop app's Chromium cookie DB. */
interface CookieRow {
  host_key: string;
  /** NULL when the column is empty (not logged in on this host). */
  encrypted_value: Uint8Array | null;
}

/** Try to extract the session token for `serverUrl` from the desktop app, with a reason on failure. */
export function extractDesktopToken(serverUrl: string): DetectResult | null {
  if (process.platform !== 'darwin') return null; // not macOS at all
  let host: string;
  try {
    // hostname, not host: Chromium's cookies.host_key never carries a port
    host = new URL(serverUrl).hostname;
  } catch {
    return { error: 'URLが不正です' };
  }
  if (!existsSync(join(APP_SUPPORT, 'config.json'))) {
    return { error: 'Mattermostデスクトップアプリが見つかりません' };
  }
  if (!existsSync(join(APP_SUPPORT, 'Cookies'))) {
    return { error: 'デスクトップアプリのCookieがありません（一度ログインしてください）' };
  }

  let row: CookieRow | null;
  try {
    row = withCookieDb((db) =>
      db
        .query(
          `SELECT host_key, encrypted_value FROM cookies
           WHERE name='MMAUTHTOKEN' AND host_key IN (?, ?)
           ORDER BY creation_utc DESC LIMIT 1`,
        )
        .get(host, `.${host}`) as CookieRow | null,
    );
  } catch (e) {
    return { error: `Cookie DBの読み取りに失敗しました (${e instanceof Error ? e.message : e})` };
  }
  if (!row?.encrypted_value?.length) {
    return {
      error: `このサーバー(${host})のセッションCookieがありません。デスクトップアプリでログインしてください`,
    };
  }

  const pass = keychainPassword();
  if (!pass) {
    return {
      error:
        'Keychainから復号キーを取得できませんでした。「security」がKeychainにアクセスする許可ダイアログで「常に許可」を選んでください',
    };
  }

  const data = Buffer.from(row.encrypted_value);
  const token = decryptMmAuthCookie(data, row.host_key, pass);
  if (token) return { token };
  return { error: `トークンの復号に失敗しました (形式=${data.subarray(0, 3).toString()}, ${data.length}バイト)` };
}

export interface DesktopSession {
  server: string;
  client: Mattermost;
  me: Me;
}

/**
 * First desktop-app session that actually verifies against its server,
 * or the per-server failure reasons when none do.
 */
export async function resolveDesktopSession(): Promise<DesktopSession | { errors: string[] }> {
  const errors: string[] = [];
  for (const server of allDesktopServers()) {
    const r = extractDesktopToken(server);
    if (!r) continue;
    if ('error' in r) {
      errors.push(`${server}: ${r.error}`);
      continue;
    }
    const client = new Mattermost(server, r.token);
    try {
      const me = await client.me();
      return { server, client, me };
    } catch {
      errors.push(`${server}: セッションが無効です（デスクトップアプリで再ログインしてください）`);
    }
  }
  return { errors };
}
