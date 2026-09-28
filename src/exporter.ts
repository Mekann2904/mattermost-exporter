/** Channel export: JSON + attachments. Shared by the TUI and headless modes. */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Mattermost } from './mattermost';

export interface ExportProgress {
  phase: 'posts' | 'files';
  postsFetched: number;
  filesDone: number;
  filesTotal: number;
  currentFile?: string;
  bytes: number;
}

export interface ExportSummary {
  channelName: string;
  channelId: string;
  outDir: string;
  postCount: number;
  fileCount: number;
  bytes: number;
  failedFiles: string[];
  dateRange: { from: string; to: string } | null;
}

/** Attachments downloaded in parallel. */
const DOWNLOAD_CONCURRENCY = 4;

export function fmtBytes(n: number): string {
  if (n > 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function safeName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_');
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function exportChannel(
  mm: Mattermost,
  channelId: string,
  outDir: string,
  onProgress?: (p: ExportProgress) => void,
): Promise<ExportSummary> {
  const channel = await mm.channel(channelId);
  const dirName = safeName(channel.display_name || channel.name || channelId);
  // Absolute so every consumer (TUI, headless log, `open`) shows/uses the full path.
  const root = resolve(join(outDir, `${dirName}-${channel.id.slice(0, 8)}`));
  const attDir = join(root, 'attachments');
  mkdirSync(attDir, { recursive: true });

  const posts = await mm.posts(channelId, (n) =>
    onProgress?.({ phase: 'posts', postsFetched: n, filesDone: 0, filesTotal: 0, bytes: 0 }),
  );
  const users = await mm.userNames(posts.map((p) => p.user_id));
  const names = await mm.fileNameMap(posts);

  const payload = {
    exported_at: new Date().toISOString(),
    server: mm.server,
    channel,
    users,
    total: posts.length,
    posts,
  };
  await Bun.write(join(root, 'channel.json'), JSON.stringify(payload, null, 2));

  // Attachment downloads are independent: run them through a small worker pool.
  const attachments = posts
    .filter((p) => p.file_ids.length)
    .flatMap((p) => p.file_ids.map((fid) => ({ fid, createAt: p.create_at })));

  let done = 0;
  let bytes = 0;
  const failed: string[] = [];
  const report = (currentFile: string | undefined): void =>
    onProgress?.({
      phase: 'files',
      postsFetched: posts.length,
      filesDone: done,
      filesTotal: attachments.length,
      currentFile,
      bytes,
    });

  report(undefined);
  const queue = [...attachments];
  const downloadNext = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const orig = names.get(item.fid) ?? item.fid;
      const path = join(attDir, `${isoDate(item.createAt)}_${item.fid.slice(0, 8)}_${safeName(orig)}`);
      try {
        const buf = await mm.download(item.fid);
        await Bun.write(path, buf);
        bytes += buf.byteLength;
      } catch {
        failed.push(orig);
      }
      done++;
      report(orig);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, attachments.length) }, () => downloadNext()),
  );

  // posts() returns oldest first; skip system join/leave messages for the date range.
  const dated = posts.filter((p) => !p.type.startsWith('system_'));
  return {
    channelName: channel.display_name,
    channelId: channel.id,
    outDir: root,
    postCount: posts.length,
    fileCount: attachments.length - failed.length,
    bytes,
    failedFiles: failed,
    dateRange: dated.length
      ? { from: isoDate(dated[0].create_at), to: isoDate(dated[dated.length - 1].create_at) }
      : null,
  };
}
