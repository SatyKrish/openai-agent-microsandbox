// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0
//
// Start the worker: load the guest image, check that a session VM boots with the
// boundaries it should have, then serve. A host that cannot sandbox fails here,
// visibly, instead of on the agent's first command.

import fs from 'node:fs/promises';
import path from 'node:path';

import * as grpc from '@grpc/grpc-js';
import { Image, ImageNotFoundError } from 'microsandbox';

import { loadConfig, type Config } from './config.js';
import { createKubeProxy, kubeconfig } from './kube-proxy.js';
import { describeEgress, kubeDir, Machines, PROXY_HOST } from './runner.js';
import { createServer, log, RUNTIME } from './server.js';

/** Start the read-only API proxy and write the kubeconfig that points VMs at it. */
async function startKubeProxy(config: Config): Promise<void> {
  const ca = await fs.readFile(config.kubeCaFile);
  await fs.access(config.kubeTokenFile);
  const proxy = createKubeProxy({ url: new URL(`https://${config.kubeApi!.host}:${config.kubeApi!.port}`), ca,
    tokenFile: config.kubeTokenFile }, config.kubeProxyPort,
  (method, requestPath, reason) => log('warn', 'API proxy refused a request', { method, path: requestPath, reason }));
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(config.kubeProxyPort, '127.0.0.1', resolve);
  });
  const dir = kubeDir(config);
  await fs.mkdir(dir, { recursive: true, mode: 0o755 });
  const namespace = config.namespaces[0] ?? 'default';
  await fs.writeFile(path.join(dir, 'config.part'), kubeconfig(`http://${PROXY_HOST}:${config.kubeProxyPort}`, namespace),
    { mode: 0o644 });
  await fs.rename(path.join(dir, 'config.part'), path.join(dir, 'config'));
}

/** The guest image comes with the worker's image, as an archive; the VMs boot from microsandbox's cache. */
async function loadGuestImage(config: Config): Promise<void> {
  try {
    await Image.get(config.guestImage);
    return;
  } catch (error) {
    if (!(error instanceof ImageNotFoundError) || !config.guestImageArchive) throw error;
  }
  const started = performance.now();
  await Image.load(config.guestImageArchive, { tag: config.guestImage });
  log('info', 'guest image loaded', { image: config.guestImage, ms: Math.round(performance.now() - started) });
}

async function selfTest(config: Config, machines: Machines): Promise<void> {
  // A name no session ID can take: IDs are [a-z0-9-] only.
  const id = 'worker.self-test';
  const root = path.join(config.dataDir, 'active', '.self-test');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  // The VM can write its workspace and sees neither the worker's journal nor a service-account token.
  const checks = ['touch ok', `test ! -e ${JSON.stringify(path.join(config.dataDir, 'history'))}`,
    'test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token'];
  // With Kubernetes access, kubectl reaches the API through the proxy, and only through it.
  if (config.egress === 'kube-api' && config.kubeApi) checks.push('test -r "$KUBECONFIG"', 'kubectl get --raw /version >/dev/null');
  try {
    await machines.destroy(id);
    const result = await machines.run(id, root, ['sh', '-c', checks.join(' && ')], root, 60_000);
    if (result.exitCode !== 0) {
      throw new Error(`VM self-test failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 1000)}`);
    }
    log('info', 'VM self-test passed', { ms: result.durationMs, checks: checks.length });
  } finally {
    await machines.destroy(id);
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  // microsandbox keeps its images, VM disks and catalog on the worker's volume; its socket
  // paths are derived from this directory, so keep it short.
  process.env.MSB_HOME ??= path.join(config.dataDir, 'msb');
  await fs.mkdir(path.join(config.dataDir, 'active'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(config.dataDir, 'history'), { recursive: true, mode: 0o700 });
  await fs.mkdir(process.env.MSB_HOME, { recursive: true, mode: 0o700 });
  await loadGuestImage(config);
  if (config.egress === 'kube-api' && config.kubeApi) await startKubeProxy(config);
  const machines = new Machines(config, log);
  if (process.env.WORKER_SKIP_SELF_TEST !== '1') await selfTest(config, machines);
  const server = createServer(config, machines);
  const address = `${config.bind}:${config.port}`;
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (error) => (error ? reject(error) : resolve()));
  });
  log('info', 'sandbox worker listening', { address, worker: config.workerId, domain: config.domain, runtime: RUNTIME,
    image: config.guestImage, egress: describeEgress(config), auth: config.token ? 'token' : 'none' });
  const stop = () => {
    log('info', 'shutting down');
    server.tryShutdown(() => void machines.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 20_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error: unknown) => {
  log('error', 'worker failed to start', { error: String((error as Error)?.message ?? error) });
  process.exit(1);
});
