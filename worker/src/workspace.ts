// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// Per-session workspaces under <data>/active/<session>. A container sees only its
// own session's directory, mounted at the same path. File I/O from the harness
// happens here, outside any container, so every path is confined to the
// workspace: lexically, and again after resolving symlinks the agent may have
// planted. Commands of the same session never run during a file operation (the
// server serializes them), so a checked path cannot be swapped underneath.

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const SESSION_ID = /^[a-z0-9][a-z0-9-]{2,62}$/;

export class WorkspaceError extends Error {
  constructor(readonly kind: 'invalid' | 'not_found' | 'too_large', message: string) {
    super(message);
  }
}

export function validSessionId(id: string): string {
  if (!SESSION_ID.test(id)) throw new WorkspaceError('invalid', 'session_id must match [a-z0-9][a-z0-9-]{2,62}');
  return id;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export class Workspaces {
  readonly base: string;

  constructor(dataDir: string) {
    this.base = path.join(dataDir, 'active');
  }

  root(id: string): string {
    return path.join(this.base, validSessionId(id));
  }

  async init(id: string): Promise<{ root: string; created: boolean }> {
    const root = this.root(id);
    await fs.mkdir(this.base, { recursive: true, mode: 0o700 });
    try {
      await fs.mkdir(root, { mode: 0o700 });
      return { root, created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fs.lstat(root);
      if (!stat.isDirectory()) throw new WorkspaceError('invalid', 'the session workspace is not a directory');
      return { root, created: false };
    }
  }

  async exists(id: string): Promise<boolean> {
    try {
      return (await fs.lstat(this.root(id))).isDirectory();
    } catch {
      return false;
    }
  }

  async count(): Promise<number> {
    try {
      return (await fs.readdir(this.base)).filter((name) => SESSION_ID.test(name)).length;
    } catch {
      return 0;
    }
  }

  async require(id: string): Promise<string> {
    if (!(await this.exists(id))) throw new WorkspaceError('not_found', `no session ${id}; call InitSession first`);
    return this.root(id);
  }

  /** The absolute path a request names, refused unless it stays in the workspace. */
  lexical(id: string, requested: string): string {
    const root = this.root(id);
    if (!requested || requested.includes('\0')) throw new WorkspaceError('invalid', 'empty path');
    const target = path.isAbsolute(requested) ? path.normalize(requested) : path.resolve(root, requested);
    if (!inside(root, target)) throw new WorkspaceError('invalid', `path leaves the workspace: ${requested}`);
    return target;
  }

  async read(id: string, requested: string, maxBytes: number, limit: number): Promise<{ data: Buffer; size: number }> {
    const root = await fs.realpath(await this.require(id));
    const target = this.lexical(id, requested);
    let real: string;
    try {
      real = await fs.realpath(target);
    } catch {
      throw new WorkspaceError('not_found', `no such file: ${requested}`);
    }
    if (!inside(root, real)) throw new WorkspaceError('invalid', `path resolves outside the workspace: ${requested}`);
    const handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new WorkspaceError('not_found', `not a regular file: ${requested}`);
      const wanted = maxBytes > 0 ? Math.min(maxBytes, stat.size) : stat.size;
      if (wanted > limit) throw new WorkspaceError('too_large', `${requested} is larger than ${limit} bytes`);
      const data = Buffer.alloc(wanted);
      let offset = 0;
      while (offset < wanted) {
        const { bytesRead } = await handle.read(data, offset, wanted - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return { data: data.subarray(0, offset), size: stat.size };
    } finally {
      await handle.close();
    }
  }

  /** Create missing parents one at a time, refusing any existing component that is not a real directory. */
  private async parents(root: string, target: string): Promise<void> {
    const parts = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean);
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (!stat.isDirectory()) throw new WorkspaceError('invalid', `not a directory: ${path.relative(root, current)}`);
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        await fs.mkdir(current, { mode: 0o755 });
      }
    }
  }

  async write(id: string, requested: string, data: Buffer, limit: number): Promise<void> {
    if (data.length > limit) throw new WorkspaceError('too_large', `content is larger than ${limit} bytes`);
    const root = await this.require(id);
    const target = this.lexical(id, requested);
    if (target === root) throw new WorkspaceError('invalid', 'cannot write the workspace root');
    await this.parents(root, target);
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile()) throw new WorkspaceError('invalid', `not a regular file: ${requested}`);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
    }
    // Write beside the target, then rename: readers see the old or the new file, never half of one.
    const partial = path.join(path.dirname(target), `.${path.basename(target)}.mxc-${randomBytes(6).toString('hex')}`);
    const handle = await fs.open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644);
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(partial, target);
    } catch (error) {
      await fs.rm(partial, { force: true });
      throw error;
    }
  }

  async destroy(id: string): Promise<boolean> {
    const existed = await this.exists(id);
    // rm does not follow symlinks inside the tree.
    await fs.rm(this.root(id), { recursive: true, force: true });
    return existed;
  }
}
