// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// One command, one Microsoft eXecution Container. On Linux MXC's Bubblewrap
// backend gives each command new user, PID, IPC, UTS and network namespaces, a
// read-only system baseline, a private /tmp, a cleared environment and a socket
// filter. The session's workspace is the only writable host path; the worker's
// journal and other sessions are not mounted. Egress is closed, or open only to
// the worker's read-only Kubernetes API proxy (kube-proxy.ts), through MXC's
// proxy-only mode; the container holds no Kubernetes credentials. Inside, prlimit
// caps address space, CPU time and open files, and choom makes the command the
// first thing the kernel kills under memory pressure, ahead of the worker itself.

import path from 'node:path';

import { run, type ContainerRequest, type ExecutionResult, type NetworkPolicy } from '@microsoft/mxc-sdk/v1';

import type { Config } from './config.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  warnings?: string[];  // MXC's own warnings about the run, for the journal and the worker's log
}

export function quote(word: string): string {
  return /^[A-Za-z0-9_./:=,@+%-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Where the worker writes the containers' kubeconfig; mounted read-only into each. */
export function kubeDir(config: Config): string {
  return path.join(config.dataDir, 'kube');
}

function kubeAccess(config: Config): boolean {
  return config.egress === 'kube-api' && config.kubeApi !== null;
}

export function network(config: Config): NetworkPolicy {
  const policy: NetworkPolicy = { egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' } };
  // Proxy-only: the proxy's loopback port, seen as 10.0.2.2 inside, is the one reachable address.
  if (kubeAccess(config)) policy.runtimeConfig = { networkProxy: `http://127.0.0.1:${config.kubeProxyPort}` };
  return policy;
}

export function describeEgress(config: Config): string {
  return kubeAccess(config)
    ? `Kubernetes API, read-only, through the worker's proxy (to ${config.kubeApi!.host}:${config.kubeApi!.port})` : 'none';
}

export function buildRequest(config: Config, root: string, argv: readonly string[], cwd: string, timeoutMs: number):
  ContainerRequest {
  const cpuSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const limits = config.containment === 'bubblewrap'
    ? `choom -n 1000 -- prlimit --as=${config.limitAddressSpaceBytes} --cpu=${cpuSeconds} --nofile=4096:4096 -- ` : '';
  const environment: Record<string, string> = {
    HOME: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1',
    KUBECACHEDIR: '/tmp/.kube/cache',
  };
  const readonlyPaths = [...config.readonlyPaths];
  if (kubeAccess(config)) {
    environment.KUBECONFIG = path.join(kubeDir(config), 'config');
    readonlyPaths.push(kubeDir(config));
  }
  const request: ContainerRequest = {
    command: `exec ${limits}${argv.map(quote).join(' ')}`,
    workingDirectory: cwd,
    timeoutMs,
    filesystem: { readwritePaths: [root], readonlyPaths },
    network: network(config),
    environment,
    inheritDefaultEnvironment: true,
  };
  if (config.containment !== 'auto') request.containment = { type: config.containment };
  return request;
}

/**
 * One workload in a transient container: MXC's create-and-run operation with
 * captured output. Bubblewrap has no persistent container lifecycle, so the
 * session's state lives in its workspace directory, not in a container.
 */
export async function runInContainer(config: Config, root: string, argv: readonly string[], cwd: string,
  timeoutMs: number): Promise<RunResult> {
  const started = performance.now();
  const result: ExecutionResult = await run(buildRequest(config, root, argv, cwd, timeoutMs));
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.timedOut ? 124 : result.exitCode,
    timedOut: result.timedOut,
    durationMs: Math.round(performance.now() - started),
    warnings: result.warnings,
  };
}
