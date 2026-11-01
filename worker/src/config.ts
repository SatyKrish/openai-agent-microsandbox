// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// Worker settings, all from the environment. Limits are ceilings: a request can
// ask for less, never more.

import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

const MIB = 1024 * 1024;

export type Egress = 'kube-api' | 'none';

export interface Config {
  port: number;
  bind: string;
  dataDir: string;
  workerId: string;
  domain: string;
  namespaces: string[];
  containment: 'bubblewrap' | 'seatbelt' | 'auto';
  egress: Egress;
  kubeApi: { host: string; port: number } | null;
  kubeProxyPort: number;
  kubeTokenFile: string;
  kubeCaFile: string;
  readonlyPaths: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  maxFileBytes: number;
  maxEvidenceBytes: number;
  maxConcurrent: number;
  limitAddressSpaceBytes: number;
  token: string | null;
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
  const egress = (process.env.MXC_EGRESS ?? 'kube-api') as Egress;
  if (egress !== 'kube-api' && egress !== 'none') throw new Error('MXC_EGRESS must be kube-api or none');
  const containment = (process.env.MXC_CONTAINMENT ?? 'bubblewrap') as Config['containment'];
  if (!['bubblewrap', 'seatbelt', 'auto'].includes(containment)) {
    throw new Error('MXC_CONTAINMENT must be bubblewrap, seatbelt or auto');
  }
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const kubeApi = host ? { host, port: Number(process.env.KUBERNETES_SERVICE_PORT || 443) } : null;
  if (kubeApi && !/^[0-9.]+$/.test(kubeApi.host)) {
    // The API proxy dials it by address: the worker pod's NetworkPolicy allows no DNS.
    throw new Error('KUBERNETES_SERVICE_HOST must be an IPv4 address');
  }
  // Containers never get the service-account token: the worker's API proxy holds it.
  const serviceAccount = '/var/run/secrets/kubernetes.io/serviceaccount';
  const readonlyPaths = list('MXC_READONLY_PATHS', []);
  const tokenFile = process.env.MXC_WORKER_TOKEN_FILE;
  const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : null;
  if (tokenFile && !token) throw new Error('MXC_WORKER_TOKEN_FILE is empty');
  const timeoutMs = integer('MXC_TIMEOUT_MS', 60_000);
  return {
    port: integer('GRPC_PORT', 50051),
    bind: process.env.GRPC_BIND ?? '0.0.0.0',
    dataDir: path.resolve(process.env.DATA_DIR ?? '/sandboxes'),
    workerId: process.env.POD_NAME ?? hostname(),
    domain: process.env.SRE_DOMAIN ?? 'default',
    namespaces: list('SRE_NAMESPACES', []),
    containment,
    egress: egress === 'kube-api' && !kubeApi ? 'none' : egress,
    kubeApi,
    kubeProxyPort: integer('MXC_KUBE_PROXY_PORT', 18080),
    kubeTokenFile: process.env.MXC_KUBE_TOKEN_FILE ?? `${serviceAccount}/token`,
    kubeCaFile: process.env.MXC_KUBE_CA_FILE ?? `${serviceAccount}/ca.crt`,
    readonlyPaths,
    timeoutMs,
    maxOutputBytes: integer('MXC_MAX_OUTPUT_BYTES', 1 * MIB),
    maxFileBytes: integer('MXC_MAX_FILE_BYTES', 10 * MIB),
    maxEvidenceBytes: integer('MXC_MAX_EVIDENCE_BYTES', 4 * MIB),
    maxConcurrent: integer('MXC_MAX_CONCURRENT', 8),
    limitAddressSpaceBytes: integer('MXC_LIMIT_AS_BYTES', 2048 * MIB),
    token,
  };
}
