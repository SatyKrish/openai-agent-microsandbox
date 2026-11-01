// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// One command, one Microsoft eXecution Container. On Linux MXC's Bubblewrap
// backend gives each command new user, PID, IPC, UTS and network namespaces, a
// read-only system baseline, a private /tmp, a cleared environment and a socket
// filter. The session's workspace is the only writable host path; the worker's
// journal and other sessions are not mounted. Egress is closed, or open only to
// the Kubernetes API service. Inside, prlimit caps address space, CPU time and
// open files, and choom makes the command the first thing the kernel kills
// under memory pressure, ahead of the worker itself.

import { run, type ContainerRequest, type ExecutionResult, type NetworkPolicy } from '@microsoft/mxc-sdk/v1';

import type { Config } from './config.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export function quote(word: string): string {
  return /^[A-Za-z0-9_./:=,@+%-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function network(config: Config): NetworkPolicy {
  const ingress = { default: 'deny', hostLoopback: 'deny' } as const;
  if (config.egress === 'kube-api' && config.kubeApi) {
    return {
      egress: {
        default: 'deny',
        allow: [{ to: [{ cidr: `${config.kubeApi.host}/32` }], ports: [{ protocol: 'tcp', port: config.kubeApi.port }] }],
      },
      ingress,
    } as NetworkPolicy;
  }
  return { egress: { default: 'deny' }, ingress } as NetworkPolicy;
}

export function describeEgress(config: Config): string {
  return config.egress === 'kube-api' && config.kubeApi
    ? `Kubernetes API only (${config.kubeApi.host}:${config.kubeApi.port})` : 'none';
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
  if (config.kubeApi) {
    environment.KUBERNETES_SERVICE_HOST = config.kubeApi.host;
    environment.KUBERNETES_SERVICE_PORT = String(config.kubeApi.port);
  }
  const request: ContainerRequest = {
    command: `exec ${limits}${argv.map(quote).join(' ')}`,
    workingDirectory: cwd,
    timeoutMs,
    filesystem: { readwritePaths: [root], readonlyPaths: config.readonlyPaths },
    network: network(config),
    environment,
    inheritDefaultEnvironment: true,
  };
  if (config.containment !== 'auto') request.containment = { type: config.containment };
  return request;
}

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
  };
}
