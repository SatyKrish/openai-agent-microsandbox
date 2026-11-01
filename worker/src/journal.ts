// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// The worker's own records under <data>/history/<session>, which no container
// can see: an append-only JSONL audit journal of every command, and the trusted
// copy of every output recorded as evidence. Output previews and evidence are
// stored after redaction.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { validSessionId } from './workspace.js';

export interface EvidenceEntry {
  seq: number;
  path: string;
  command: string;
  sha256: string;
  bytes: number;
  exit_code: number;
  recorded_at: string;
}

export interface CommandRecord {
  argv: readonly string[];
  cwd: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: Buffer;
  stderr: Buffer;
  evidenceSeq?: number;
}

const PREVIEW = 500;

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export class Journal {
  readonly base: string;
  private readonly evidence = new Map<string, EvidenceEntry[]>();

  constructor(dataDir: string) {
    this.base = path.join(dataDir, 'history');
  }

  private dir(id: string): string {
    return path.join(this.base, validSessionId(id));
  }

  private async append(id: string, file: string, record: object): Promise<void> {
    const dir = this.dir(id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.appendFile(path.join(dir, file), JSON.stringify(record) + '\n', { mode: 0o600 });
  }

  async event(id: string, event: string, detail: object = {}): Promise<void> {
    await this.append(id, 'journal.jsonl', { ts: new Date().toISOString(), event, ...detail });
  }

  async command(id: string, record: CommandRecord): Promise<void> {
    await this.append(id, 'journal.jsonl', {
      ts: new Date().toISOString(), event: 'exec', argv: record.argv, cwd: record.cwd, exit_code: record.exitCode,
      timed_out: record.timedOut, duration_ms: record.durationMs, stdout_bytes: record.stdout.length,
      stderr_bytes: record.stderr.length, output_sha256: sha256(Buffer.concat([record.stdout, record.stderr])),
      stdout_preview: record.stdout.subarray(0, PREVIEW).toString('utf8'),
      stderr_preview: record.stderr.subarray(0, PREVIEW).toString('utf8'),
      ...(record.evidenceSeq ? { evidence_seq: record.evidenceSeq } : {}),
    });
  }

  async entries(id: string): Promise<EvidenceEntry[]> {
    const cached = this.evidence.get(id);
    if (cached) return cached;
    let loaded: EvidenceEntry[] = [];
    try {
      const text = await fs.readFile(path.join(this.dir(id), 'evidence.jsonl'), 'utf8');
      loaded = text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as EvidenceEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.evidence.set(id, loaded);
    return loaded;
  }

  async nextSeq(id: string): Promise<number> {
    return (await this.entries(id)).length + 1;
  }

  /** Keep the trusted copy first; the entry exists only once its content does. */
  async record(id: string, entry: Omit<EvidenceEntry, 'sha256' | 'bytes' | 'recorded_at'>, content: Buffer):
    Promise<EvidenceEntry> {
    const dir = path.join(this.dir(id), 'evidence');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dir, `${String(entry.seq).padStart(6, '0')}.txt`), content, { mode: 0o600 });
    const full: EvidenceEntry = { ...entry, sha256: sha256(content), bytes: content.length,
      recorded_at: new Date().toISOString() };
    await this.append(id, 'evidence.jsonl', full);
    (await this.entries(id)).push(full);
    return full;
  }

  async read(id: string, seq: number): Promise<{ entry: EvidenceEntry; content: Buffer } | null> {
    const entry = (await this.entries(id)).find((item) => item.seq === seq);
    if (!entry) return null;
    const content = await fs.readFile(path.join(this.dir(id), 'evidence', `${String(seq).padStart(6, '0')}.txt`));
    return { entry, content };
  }

  async purge(id: string): Promise<void> {
    this.evidence.delete(id);
    await fs.rm(this.dir(id), { recursive: true, force: true });
  }

  forget(id: string): void {
    this.evidence.delete(id);
  }
}
