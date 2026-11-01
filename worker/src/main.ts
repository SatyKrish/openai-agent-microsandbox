// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// Start the worker: check that MXC can launch a container on this host, then
// serve. A host that cannot sandbox fails here, visibly, instead of on the
// agent's first command.

import fs from 'node:fs/promises';
import path from 'node:path';

import * as grpc from '@grpc/grpc-js';
import { getPlatformSupport } from '@microsoft/mxc-sdk/v1';

import { loadConfig, type Config } from './config.js';
import { createKubeProxy, kubeconfig } from './kube-proxy.js';
import { describeEgress, kubeDir, runInContainer } from './runner.js';
import { createServer, log } from './server.js';

/** Start the read-only API proxy and write the kubeconfig that points containers at it. */
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
  await fs.writeFile(path.join(dir, 'config.part'), kubeconfig(config.kubeProxyPort, namespace), { mode: 0o644 });
  await fs.rename(path.join(dir, 'config.part'), path.join(dir, 'config'));
}

async function selfTest(config: Config): Promise<void> {
  const support = getPlatformSupport();
  if (!support.isSupported) throw new Error(`MXC is not supported on this host: ${support.reason}`);
  // MXC never falls back from proxy-only egress to a shared network; neither does the worker.
  if (config.egress === 'kube-api' && config.kubeApi && support.bubblewrapNetwork?.proxyEnforcement !== 'supported') {
    throw new Error('MXC cannot enforce proxy-only egress on this host: '
      + (support.bubblewrapNetwork?.warnings.join('; ') || 'no Bubblewrap network support reported'));
  }
  // A directory no session ID can name: IDs start with [a-z0-9].
  const root = path.join(config.dataDir, 'active', '.self-test');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  // The container can write its workspace and cannot see the worker's journal.
  const history = path.join(config.dataDir, 'history');
  const result = await runInContainer({ ...config, egress: 'none' }, root,
    ['sh', '-c', 'touch ok && test ! -e "$1"', 'sh', history], root, 15_000);
  await fs.rm(root, { recursive: true, force: true });
  if (result.exitCode !== 0) {
    throw new Error(`MXC self-test failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 1000)}`);
  }
  if (config.egress === 'kube-api' && config.kubeApi) {
    // The proxy-only network starts, the kubeconfig is visible, and no token is. MXC's own
    // tests require CapBnd, CapEff and CapPrm to be zero in proxy mode: that is what keeps
    // the supervisor's user-namespace descriptor, which stays open in the workload, inert.
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const proxied = await runInContainer(config, root, ['sh', '-c',
      'test -r "$KUBECONFIG" && test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token && '
      + 'test "$(grep -cE \'^Cap(Bnd|Eff|Prm):[[:space:]]+0+$\' /proc/self/status)" = 3'], root, 15_000);
    await fs.rm(root, { recursive: true, force: true });
    if (proxied.exitCode !== 0) {
      throw new Error(`MXC self-test with the API proxy failed (exit ${proxied.exitCode}): ${proxied.stderr.trim().slice(0, 1000)}`);
    }
  }
  log('info', 'MXC self-test passed', { methods: support.availableMethods, ms: result.durationMs,
    bubblewrap_network: support.bubblewrapNetwork?.proxyEnforcement });
}

async function main(): Promise<void> {
  const config = loadConfig();
  await fs.mkdir(path.join(config.dataDir, 'active'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(config.dataDir, 'history'), { recursive: true, mode: 0o700 });
  if (config.egress === 'kube-api' && config.kubeApi) await startKubeProxy(config);
  if (process.env.MXC_SKIP_SELF_TEST !== '1') await selfTest(config);
  const server = createServer(config);
  const address = `${config.bind}:${config.port}`;
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (error) => (error ? reject(error) : resolve()));
  });
  log('info', 'MXC sandbox worker listening', { address, worker: config.workerId, domain: config.domain,
    containment: config.containment, egress: describeEgress(config), auth: config.token ? 'token' : 'none' });
  const stop = () => {
    log('info', 'shutting down');
    server.tryShutdown(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error: unknown) => {
  log('error', 'worker failed to start', { error: String((error as Error)?.message ?? error) });
  process.exit(1);
});
