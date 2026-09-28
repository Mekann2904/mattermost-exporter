/** Channel export: JSON + attachments. Shared by the TUI and headless modes. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Mattermost, Post } from './mattermost';

export interface ExportProgress {
  phase: 'posts' | 'files' | 'done';
  postsFetched: number;
  filesDone: number;
  filesTotal: number;
  currentFile?: string;
  bytes: number;
  error?: string;
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
  const root = join(outDir, `${dirName}-${channel.id.slice(0, 8)}`);
  const attDir = join(root, 'attachments');
  mkdirSync(attDir, { recursive: true });

  const posts = await mm.posts(channelId, (n) =>
    onProgress?.({ phase: 'posts', postsFetched: n, filesDone: 0, filesTotal: 0, bytes: 0 }),
  );
  const users = await mm.userNames(posts.map((p) => p.user_id));

  const filePosts = posts.filter((p) => p.file_ids?.length);
  const fileCount = filePosts.reduce((n, p) => n + p.file_ids.length, 0);
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

  let done = 0;
  let bytes = 0;
  const failed: string[] = [];
  for (const p of filePosts) {
    for (const fid of p.file_ids) {
      const orig = names.get(fid) ?? fid;
      const path = join(attDir, `${isoDate(p.create_at)}_${fid.slice(0, 8)}_${safeName(orig)}`);
      onProgress?.({
        phase: 'files',
        postsFetched: posts.length,
        filesDone: done,
        filesTotal: fileCount,
        currentFile: orig,
        bytes,
      });
      try {
        const buf = await mm.download(fid);
        await Bun.write(path, buf);
        bytes += buf.byteLength;
      } catch (e) {
        failed.push(orig);
        void e;
      }
      done++;
    }
  }

  const sorted = posts.filter((p: Post) => !p.type?.startsWith('system_'));
  const summary: ExportSummary = {
    channelName: channel.display_name,
    channelId: channel.id,
    outDir: root,
    postCount: posts.length,
    fileCount: fileCount - failed.length,
    bytes,
    failedFiles: failed,
    dateRange: sorted.length
      ? {
          from: isoDate(sorted[0].create_at),
          to: isoDate(sorted[sorted.length - 1].create_at),
        }
      : null,
  };
  onProgress?.({ ...summaryProgress(summary), phase: 'done' });
  return summary;
}

function summaryProgress(s: ExportSummary): ExportProgress {
  return {
    phase: 'done',
    postsFetched: s.postCount,
    filesDone: s.fileCount,
    filesTotal: s.fileCount + s.failedFiles.length,
    bytes: s.bytes,
  };
}
