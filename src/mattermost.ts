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
}

export class ApiError extends Error {
  constructor(readonly path: string, readonly status: number, body: string) {
    super(`GET ${path} -> ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

export class Mattermost {
  constructor(readonly server: string, readonly token: string) {
    this.server = server.replace(/\/+$/, '');
  }

  /** Login with login_id + password (email or username). Returns a client + token. */
  static async login(
    server: string,
    loginId: string,
    password: string,
  ): Promise<{ client: Mattermost; token: string; me: { id: string; username: string } }> {
    const base = server.replace(/\/+$/, '');
    const res = await fetch(`${base}/api/v4/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login_id: loginId, password }),
    });
    if (!res.ok) {
      throw new ApiError('/api/v4/users/login', res.status, await res.text().catch(() => ''));
    }
    const token = res.headers.get('token');
    if (!token) throw new ApiError('/api/v4/users/login', res.status, 'no token header');
    const me = (await res.json()) as { id: string; username: string };
    return { client: new Mattermost(base, token), token, me };
  }

  private async api<T>(path: string): Promise<T> {
    const res = await fetch(this.server + path, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new ApiError(path, res.status, await res.text().catch(() => ''));
    }
    return (await res.json()) as T;
  }

  async me(): Promise<{ id: string; username: string }> {
    return this.api('/api/v4/users/me');
  }

  async verify(): Promise<{ id: string; username: string }> {
    return this.me(); // throws on invalid token
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
    const seen = new Set<string>();
    const out: Channel[] = [];
    for (const t of teams) {
      for (const ch of await this.channelsForTeam(t.id)) {
        if (!seen.has(ch.id)) {
          seen.add(ch.id);
          out.push(ch);
        }
      }
    }
    return out;
  }

  channel(id: string): Promise<Channel> {
    return this.api(`/api/v4/channels/${id}`);
  }

  /** All posts of a channel, oldest first. */
  async posts(
    channelId: string,
    onProgress?: (count: number) => void,
  ): Promise<Post[]> {
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

  /** file id -> original filename (uses list metadata, falls back per-post). */
  async fileNameMap(posts: Post[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const need: string[] = [];
    for (const p of posts) {
      const files = (p as Post & { metadata?: { files?: { id: string; name: string }[] } })
        .metadata?.files;
      if (files?.length) {
        for (const f of files) map.set(f.id, f.name);
      } else if (p.file_ids?.length) {
        need.push(p.id);
      }
    }
    for (const id of need) {
      try {
        const post = await this.api<Post & { metadata?: { files?: { id: string; name: string }[] } }>(
          `/api/v4/posts/${id}`,
        );
        for (const f of post.metadata?.files ?? []) map.set(f.id, f.name);
      } catch {
        // keep going; file will be saved under its id
      }
    }
    return map;
  }

  async userNames(userIds: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const id of [...new Set(userIds)]) {
      try {
        out[id] = (await this.api<{ username: string }>(`/api/v4/users/${id}`)).username;
      } catch {
        out[id] = id;
      }
    }
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
