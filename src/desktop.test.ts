/**
 * decryptMmAuthCookie の単体テスト (Keychain・デスクトップアプリ不要)。
 *
 * デスクトップアプリの世代差を反映した2レイアウトを検証する:
 *   新 (Chromium 130+ / デスクトップ v5.10.0+): sha256(host_key)[32] + token + PKCS7
 *   旧 (それ以前):                              token + PKCS7
 * 暗号方式は v10 プレフィクス + AES-128-CBC (鍵=PBKDF2(pass,'saltysalt',1003),
 * IV=0x20×16) — Chromium os_crypt (macOS) と同じ構成でテストデータを作る。
 */
import { describe, it, expect } from 'bun:test';
import { pbkdf2Sync, createCipheriv, createHash } from 'node:crypto';
import { decryptMmAuthCookie, describeVerifyFailure, maskToken } from './desktop';
import { ApiError } from './mattermost';

const PASS = 'test-pass';
const HOST = 'mattermost.example.com';
const TOKEN = 'abcdefghijklmnopqrstuvwx26'; // NewId() 相当の26文字

const key = pbkdf2Sync(PASS, 'saltysalt', 1003, 16, 'sha1');

/** Chromium と同じ構成で v10 Cookie を作る */
function encrypt(plain: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
}

const mac = createHash('sha256').update(Buffer.from(HOST, 'latin1')).digest();
const newLayout = encrypt(Buffer.concat([mac, Buffer.from(TOKEN)])); // 67バイト相当
const oldLayout = encrypt(Buffer.from(TOKEN)); // 35バイト相当 (旧実装は <48 で弾いていた)

describe('maskToken', () => {
  it('先頭6字 + 省略記号のみを返す（全文を出さない）', () => {
    const token = 'abcdefghijklmnopqrstuvwx';
    const masked = maskToken(token);
    expect(masked).toBe('abcdef…');
    expect(masked.length).toBeLessThan(token.length);
  });
});

describe('describeVerifyFailure', () => {
  it('401はセッション無効として分類（再ログイン指示を含む）', () => {
    const msg = describeVerifyFailure(new ApiError('/api/v4/users/me', 401, ''));
    expect(msg).toContain('セッションが無効');
    expect(msg).toContain('401');
    expect(msg).toContain('再ログイン');
  });

  it('403もセッション無効として分類', () => {
    expect(describeVerifyFailure(new ApiError('/api/v4/users/me', 403, ''))).toContain('セッションが無効');
  });

  it('5xxは接続系として分類（再ログインを促さない）', () => {
    const msg = describeVerifyFailure(new ApiError('/api/v4/users/me', 502, ''));
    expect(msg).toContain('接続できません');
    expect(msg).not.toContain('再ログイン');
  });

  it('通常のError（ネットワーク/TLS失敗）は接続系として分類', () => {
    const msg = describeVerifyFailure(new Error('Unable to connect. Is the computer able to access the url?'));
    expect(msg).toContain('接続できません');
    expect(msg).toContain('ネットワーク');
  });
});

describe('decryptMmAuthCookie', () => {
  it('新レイアウト (sha256(host_key)接頭辞あり) からトークンを取り出す', () => {
    expect(decryptMmAuthCookie(newLayout, HOST, PASS)).toBe(TOKEN);
  });

  it('host_key は「DB保存のまま」ハッシュする: 先頭ドット付きでもそのまま渡せば復号できる', () => {
    const dottedHost = `.${HOST}`;
    const dottedMac = createHash('sha256').update(Buffer.from(dottedHost, 'latin1')).digest();
    const dotted = encrypt(Buffer.concat([dottedMac, Buffer.from(TOKEN)]));
    expect(decryptMmAuthCookie(dotted, dottedHost, PASS)).toBe(TOKEN);
  });

  it('旧レイアウト (接頭辞なし・35バイト) からトークンを取り出す', () => {
    expect(decryptMmAuthCookie(oldLayout, HOST, PASS)).toBe(TOKEN);
  });

  it('host_key 不一致 (偽MAC) なら null を返す', () => {
    expect(decryptMmAuthCookie(newLayout, 'other.example.com', PASS)).toBeNull();
  });

  it('ブロック長が不正でも例外にならず null', () => {
    expect(decryptMmAuthCookie(Buffer.from('v10' + 'x'.repeat(40)), HOST, PASS)).toBeNull();
  });

  it('未知の接頭辞 (v11等) は null', () => {
    expect(decryptMmAuthCookie(Buffer.from('v11' + 'x'.repeat(32)), HOST, PASS)).toBeNull();
  });

  it('復号はできるがトークンの形をしていなければ null', () => {
    const short = encrypt(Buffer.from('short')); // 5文字 → TOKEN_RE 不可
    expect(decryptMmAuthCookie(short, HOST, PASS)).toBeNull();
  });

  it('空のデータは null', () => {
    expect(decryptMmAuthCookie(Buffer.alloc(0), HOST, PASS)).toBeNull();
  });
});
