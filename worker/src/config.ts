// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// Worker settings, all from the environment. Limits are ceilings: a request can
// ask for less, never more.

import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

import type { LogPolicy } from './log-policy.js';

const MIB = 1024 * 1024;

export type Egress = 'kube-api' | 'none';

export interface Config {
  port: number;
  bind: string;
  dataDir: string;
  workerId: string;
  domain: string;
  namespaces: string[];
  egress: Egress;
  kubeApi: { host: string; port: number } | null;
  kubeProxyPort: number;
  kubeTokenFile: string;
  kubeCaFile: string;
  guestImage: string;              // the image every session's VM boots
  guestImageArchive: string | null;  // a `docker save` archive of it, loaded at startup when not cached
  vmCpus: number;
  vmMemoryMib: number;
  maxRunning: number;              // VMs running at once; the least recently used idle one is stopped
  idleStopMs: number;              // an idle VM is stopped after this long; its disk stays
  timeoutMs: number;
  maxOutputBytes: number;
  maxFileBytes: number;
  maxEvidenceBytes: number;
  token: string | null;
  logTailLines: number;     // default lines read from the end of a log
  logMaxTailLines: number;  // the most a caller may ask for
  logMaxBytes: number;      // the most raw log the worker reads at once
  logPolicy: LogPolicy;     // what of it may reach the model
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  const egress = (process.env.WORKER_EGRESS ?? 'kube-api') as Egress;
  if (egress !== 'kube-api' && egress !== 'none') throw new Error('WORKER_EGRESS must be kube-api or none');
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const kubeApi = host ? { host, port: Number(process.env.KUBERNETES_SERVICE_PORT || 443) } : null;
  if (kubeApi && !/^[0-9.]+$/.test(kubeApi.host)) {
    // The API proxy dials it by address: the worker pod's NetworkPolicy allows no DNS.
    throw new Error('KUBERNETES_SERVICE_HOST must be an IPv4 address');
  }
  // VMs never get the service-account token: the worker's API proxy holds it.
  const serviceAccount = '/var/run/secrets/kubernetes.io/serviceaccount';
  const tokenFile = process.env.WORKER_TOKEN_FILE;
  const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : null;
  if (tokenFile && !token) throw new Error('WORKER_TOKEN_FILE is empty');
  const timeoutMs = integer('WORKER_TIMEOUT_MS', 60_000);
  return {
    port: integer('GRPC_PORT', 50051),
    bind: process.env.GRPC_BIND ?? '0.0.0.0',
    dataDir: path.resolve(process.env.DATA_DIR ?? '/sandboxes'),
    workerId: process.env.POD_NAME ?? hostname(),
    domain: process.env.SRE_DOMAIN ?? 'default',
    namespaces: list('SRE_NAMESPACES', []),
    egress: egress === 'kube-api' && !kubeApi ? 'none' : egress,
    kubeApi,
    kubeProxyPort: integer('WORKER_KUBE_PROXY_PORT', 18080),
    kubeTokenFile: process.env.WORKER_KUBE_TOKEN_FILE ?? `${serviceAccount}/token`,
    kubeCaFile: process.env.WORKER_KUBE_CA_FILE ?? `${serviceAccount}/ca.crt`,
    guestImage: process.env.WORKER_GUEST_IMAGE ?? 'sre-sandbox-guest:local',
    guestImageArchive: process.env.WORKER_GUEST_IMAGE_ARCHIVE || null,
    vmCpus: integer('WORKER_VM_CPUS', 1),
    vmMemoryMib: integer('WORKER_VM_MEMORY_MIB', 768),
    maxRunning: integer('WORKER_MAX_RUNNING', 4),
    idleStopMs: integer('WORKER_IDLE_STOP_S', 600) * 1000,
    timeoutMs,
    maxOutputBytes: integer('WORKER_MAX_OUTPUT_BYTES', 1 * MIB),
    maxFileBytes: integer('WORKER_MAX_FILE_BYTES', 10 * MIB),
    maxEvidenceBytes: integer('WORKER_MAX_EVIDENCE_BYTES', 4 * MIB),
    token,
    logTailLines: integer('WORKER_LOG_TAIL_LINES', 500),
    logMaxTailLines: integer('WORKER_LOG_MAX_TAIL_LINES', 5000),
    logMaxBytes: integer('WORKER_LOG_MAX_BYTES', 4 * MIB),
    logPolicy: {
      maxLines: integer('WORKER_LOG_EXCERPT_LINES', 40),
      maxBytes: integer('WORKER_LOG_EXCERPT_BYTES', 6000),
      context: integer('WORKER_LOG_CONTEXT_LINES', 2),
      tail: integer('WORKER_LOG_LAST_LINES', 3),
      lineChars: 240,
    },
  };
}
