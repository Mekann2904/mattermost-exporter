/**
 * Auto-detect the Mattermost session token from the macOS desktop app.
 *
 * The Electron app stores an MMAUTHTOKEN cookie in its Chromium cookie DB,
 * encrypted with a key derived (PBKDF2) from the "Mattermost Safe Storage"
 * password in the macOS Keychain. Plaintext layout (AES-128-CBC, IV=spaces):
 *   sha256(host_key)[32 bytes] + token + PKCS7 padding
 */
import { pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { existsSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_SUPPORT = join(homedir(), 'Library/Application Support/Mattermost');

export function isMacosDesktopInstalled(): boolean {
  return process.platform === 'darwin' && existsSync(join(APP_SUPPORT, 'config.json'));
}

/** Server URLs registered in the desktop app. */
export function desktopServerList(): string[] {
  const cfgPath = join(APP_SUPPORT, 'config.json');
  if (!existsSync(cfgPath)) return [];
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const teams = Array.isArray(cfg?.teams) ? cfg.teams : [];
    return teams
      .map((t: { url?: string }) => (t.url ?? '').replace(/\/+$/, ''))
      .filter((u: string) => u.length > 0);
  } catch {
    return [];
  }
}

function keychainPassword(): string | null {
  try {
    const r = Bun.spawnSync([
      'security', 'find-generic-password', '-s', 'Mattermost Safe Storage', '-w',
    ]);
    const out = r.stdout?.toString().trim();
    return out && r.exitCode === 0 ? out : null;
  } catch {
    return null;
  }
}

/** Try to extract the session token for `serverUrl` from the desktop app. Returns null on failure. */
export function extractDesktopToken(serverUrl: string): string | null {
  if (process.platform !== 'darwin') return null;
  let host: string;
  try {
    host = new URL(serverUrl).host;
  } catch {
    return null;
  }
  const cookiesPath = join(APP_SUPPORT, 'Cookies');
  if (!existsSync(cookiesPath)) return null;

  const tmp = join(tmpdir(), `mattermost-exporter-cookies-${process.pid}`);
  let data: Uint8Array | undefined;
  try {
    copyFileSync(cookiesPath, tmp); // DB may be locked by the running app; a copy reads fine
    const db = new Database(tmp, { readonly: true });
    const row = db
      .query(
        `SELECT encrypted_value FROM cookies WHERE name='MMAUTHTOKEN' AND host_key LIKE ? LIMIT 1`,
      )
      .get(`%${host}`) as { encrypted_value?: Uint8Array } | null;
    db.close();
    data = row?.encrypted_value ?? undefined;
  } catch {
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
  if (!data || data.length < 48) return null;

  const pass = keychainPassword();
  if (!pass) return null;

  try {
    const buf = Buffer.from(data);
    if (buf.subarray(0, 3).toString() !== 'v10') return null;
    const key = pbkdf2Sync(pass, 'saltysalt', 1003, 16, 'sha1');
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const pt = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
    // plaintext: 32-byte host hash + token + PKCS7 padding
    const token = pt.subarray(32).toString('latin1').replace(/[\x01-\x10]+$/, '');
    return /^[\x21-\x7e]{20,40}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}
