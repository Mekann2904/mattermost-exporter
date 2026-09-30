/** Minimal Mattermost REST API v4 client (token auth). */

export interface Channel {
  id: string;
  team_id: string;
  display_name: string;
  name: string;
  type: string; // O = public, P = private, D = direct
  total_msg_count?: number;
  last_post_at?: number;
  create_at?: number;
}

export interface FileInfo {
  id: string;
  name: string;
}

/** Extra fields the API attaches to posts; `files` is set for posts with attachments. */
export interface PostMetadata {
  files?: FileInfo[];
}

export interface Post {
  id: string;
  create_at: number;
  update_at: number;
  user_id: string;
  channel_id: string;
  root_id: string;
  message: string;
  type: string;
  file_ids: string[];
  props?: Record<string, unknown>;
  metadata?: PostMetadata;
}

export interface Me {
  id: string;
  username: string;
}

/** A session row from /users/me/sessions (fields we use for diagnostics). */
export interface SessionInfo {
  id: string;
  create_at: number;
  expires_at: number;
  last_activity_at: number;
  props?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    body: string,
    readonly method = 'GET',
  ) {
    super(`${method} ${path} -> ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

type ApiInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

export class Mattermost {
  constructor(readonly server: string, readonly token: string) {
    this.server = server.replace(/\/+$/, '');
  }

  private async api<T>(path: string, init: ApiInit = {}): Promise<T> {
    const res = await fetch(this.server + path, {
      method: 'GET',
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, ...init.headers },
    });
    if (!res.ok) {
      throw new ApiError(path, res.status, await res.text().catch(() => ''), init.method ?? 'GET');
    }
    return (await res.json()) as T;
  }

  /** Current user; throws (401 ApiError) when the token is invalid. */
  async me(): Promise<Me> {
    return this.api('/api/v4/users/me');
  }

  /** Active sessions of the current user (for diagnostics). */
  async mySessions(): Promise<SessionInfo[]> {
    return this.api('/api/v4/users/me/sessions');
  }

  async teams(): Promise<{ id: string; display_name: string; name: string }[]> {
    return this.api('/api/v4/users/me/teams');
  }

  async channelsForTeam(teamId: string): Promise<Channel[]> {
    return this.api(`/api/v4/users/me/teams/${teamId}/channels`);
  }

  /** All channels I am a member of, across all my teams (deduplicated). */
  async allChannels(): Promise<Channel[]> {
    const teams = await this.teams();
    const lists = await Promise.all(teams.map((t) => this.channelsForTeam(t.id)));
    const seen = new Set<string>();
    const out: Channel[] = [];
    for (const ch of lists.flat()) {
      if (!seen.has(ch.id)) {
        seen.add(ch.id);
        out.push(ch);
      }
    }
    return out;
  }

  channel(id: string): Promise<Channel> {
    return this.api(`/api/v4/channels/${id}`);
  }

  /** All posts of a channel, oldest first. */
  async posts(channelId: string, onProgress?: (count: number) => void): Promise<Post[]> {
    const all: Post[] = [];
    for (let page = 0; ; page++) {
      const r = await this.api<{ order: string[]; posts: Record<string, Post> }>(
        `/api/v4/channels/${channelId}/posts?page=${page}&per_page=200`,
      );
      if (!r.order?.length) break;
      for (const id of r.order) all.push(r.posts[id]);
      onProgress?.(all.length);
    }
    all.sort((a, b) => a.create_at - b.create_at);
    return all;
  }

  /** file id -> original filename (list metadata first, per-post fallback for posts that lack it). */
  async fileNameMap(posts: Post[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const need: string[] = [];
    for (const p of posts) {
      const files = p.metadata?.files;
      if (files?.length) {
        for (const f of files) map.set(f.id, f.name);
      } else if (p.file_ids.length) {
        need.push(p.id);
      }
    }
    await Promise.all(
      need.map(async (id) => {
        try {
          const post = await this.api<Post>(`/api/v4/posts/${id}`);
          for (const f of post.metadata?.files ?? []) map.set(f.id, f.name);
        } catch {
          // keep going; file will be saved under its id
        }
      }),
    );
    return map;
  }

  /** Usernames for the given ids via the batch endpoint; unresolvable ids map to themselves. */
  async userNames(userIds: string[]): Promise<Record<string, string>> {
    const ids = [...new Set(userIds)];
    const out: Record<string, string> = {};
    if (!ids.length) return out;

    const CHUNK = 500; // stay well under the server-side limit on POST /users/ids
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));

    const groups = await Promise.all(
      chunks.map((chunk) =>
        this
          .api<Me[]>('/api/v4/users/ids', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(chunk),
          })
          .catch(() => [] as Me[]),
      ),
    );
    for (const u of groups.flat()) out[u.id] = u.username;
    for (const id of ids) if (!(id in out)) out[id] = id;
    return out;
  }

  async download(fileId: string): Promise<ArrayBuffer> {
    const res = await fetch(`${this.server}/api/v4/files/${fileId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new ApiError(`/api/v4/files/${fileId}`, res.status, '');
    return res.arrayBuffer();
  }
}
