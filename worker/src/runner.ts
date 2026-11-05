// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// One session, one microVM (microsandbox: libkrun on KVM). The VM starts on the
// session's first command, stops after it has been idle, and keeps its disk until
// the session is destroyed. It has its own kernel, and vCPU and memory limits the
// hypervisor enforces. It sees its image and the session's workspace, mounted at
// the same path as on the worker's volume; the worker's journal, other sessions
// and the service-account token are never mounted. Egress is closed, or open only
// to the worker's read-only Kubernetes API proxy on the pod's loopback (reached as
// host.microsandbox.internal inside), with microsandbox's deny-by-default network
// policy; the VM holds no Kubernetes credentials.

import path from 'node:path';

import { ExecTimeoutError, NetworkPolicy, Sandbox, SandboxNotFoundError, SandboxStillRunningError } from 'microsandbox';

import type { Config } from './config.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/** What the server needs from the sandboxes: a command in a session's VM, a file through it, and its end. */
export interface Runner {
  run(id: string, root: string, argv: readonly string[], cwd: string, timeoutMs: number): Promise<RunResult>;
  /** Write a workspace file through the session's running VM. False when it is not running: write on the volume. */
  write(id: string, file: string, data: Buffer): Promise<boolean>;
  destroy(id: string): Promise<void>;
}

/** The API proxy's address as the VM sees it: the pod's loopback, through microsandbox's gateway. */
export const PROXY_HOST = 'host.microsandbox.internal';
/** Where the worker's kubeconfig is mounted, read-only, in each VM. */
export const GUEST_KUBE_DIR = '/etc/sandbox/kube';

/** Where the worker writes the VMs' kubeconfig. */
export function kubeDir(config: Config): string {
  return path.join(config.dataDir, 'kube');
}

function kubeAccess(config: Config): boolean {
  return config.egress === 'kube-api' && config.kubeApi !== null;
}

export function describeEgress(config: Config): string {
  return kubeAccess(config)
    ? `Kubernetes API, read-only, through the worker's proxy (to ${config.kubeApi!.host}:${config.kubeApi!.port})` : 'none';
}

export interface VmSpec {
  name: string;
  image: string;
  cpus: number;
  memoryMib: number;
  workdir: string;
  mounts: { guest: string; host: string; readonly: boolean }[];
  env: Record<string, string>;
  network: { mode: 'none' } | { mode: 'proxy'; port: number };
}

/** A session's VM as plain data: what it runs, what it sees and where it may connect. */
export function vmSpec(config: Config, id: string, root: string): VmSpec {
  const env: Record<string, string> = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1' };
  const mounts = [{ guest: root, host: root, readonly: false }];
  if (kubeAccess(config)) {
    env.KUBECONFIG = `${GUEST_KUBE_DIR}/config`;
    mounts.push({ guest: GUEST_KUBE_DIR, host: kubeDir(config), readonly: true });
  }
  return { name: id, image: config.guestImage, cpus: config.vmCpus, memoryMib: config.vmMemoryMib, workdir: root, mounts,
    env, network: kubeAccess(config) ? { mode: 'proxy', port: config.kubeProxyPort } : { mode: 'none' } };
}

function create(spec: VmSpec): Promise<Sandbox> {
  let builder = Sandbox.builder(spec.name).image(spec.image).cpus(spec.cpus).memory(spec.memoryMib)
    .workdir(spec.workdir).security('restricted');
  for (const [key, value] of Object.entries(spec.env)) builder = builder.env(key, value);
  for (const mount of spec.mounts) {
    builder = builder.volume(mount.guest, (m) => (mount.readonly ? m.bind(mount.host).readonly() : m.bind(mount.host)));
  }
  const { network } = spec;
  builder = network.mode === 'none' ? builder.disableNetwork()
    : builder.network((n) => n.policy(NetworkPolicy.builder().defaultDeny()
      // The gateway's DNS resolves host.microsandbox.internal; the worker pod's own
      // NetworkPolicy allows no DNS beyond it.
      .egress((e) => e.udp().tcp().port(53).allowHost())
      .egress((e) => e.tcp().port(network.port).allowHost())
      .build()));
  return builder.create();
}

/** How long a VM must have been idle before another session's VM may take its place. */
const SETTLED_MS = 10_000;

interface Machine {
  sandbox: Sandbox;
  lastUsed: number;
  busy: number;
}

/**
 * The worker's VMs: at most ``maxRunning`` running or starting at once. To start another, the least
 * recently used idle one stops; when every one is busy, the new one waits for one to go idle, so a
 * small node is never asked to boot more VMs than it can run.
 */
export class Machines implements Runner {
  private live = new Map<string, Machine>();
  // Stops in flight. Another session can stop this one's VM to make room between its commands;
  // its next command or file waits for the stop, so it never reaches a VM that is going away.
  private stopping = new Map<string, Promise<void>>();
  private opening = 0;  // VMs being started or created, which count against maxRunning
  private waiters: Array<() => void> = [];
  private sweeper: NodeJS.Timeout;

  constructor(private config: Config, private log: (level: 'info' | 'warn', msg: string, fields?: object) => void) {
    this.sweeper = setInterval(() => void this.sweep(), 30_000);
    this.sweeper.unref();
  }

  get running(): number {
    return this.live.size;
  }

  /** The session's running VM, already marked busy, so nothing stops it before the caller uses it. */
  private async machine(id: string, root: string): Promise<Machine> {
    await this.stopping.get(id);
    const known = this.live.get(id);
    if (known) {
      known.busy += 1;
      return known;
    }
    await this.makeRoom();
    try {
      let sandbox: Sandbox;
      try {
        const handle = await Sandbox.get(id);
        if (handle.status === 'running' || handle.status === 'starting') {
          // Left running by an earlier worker process, or by one that died: reconnect, or restart it.
          sandbox = await handle.connect().catch(async () => {
            await handle.kill().catch(() => undefined);
            return handle.start();
          });
        } else {
          sandbox = await handle.start().catch((error: unknown) => {
            if (error instanceof SandboxStillRunningError) return handle.connect();
            throw error;
          });
        }
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
        sandbox = await create(vmSpec(this.config, id, root));
        this.log('info', 'session VM created', { session: id });
      }
      if (kubeAccess(this.config)) {
        // A fresh VM's first kubectl spends seconds reading the binary from its disk, more on a
        // busy node; read it now, under the VM's start rather than the agent's first command.
        await sandbox.execWith('kubectl', (b) => b.args(['version', '--client']).timeout(60_000)).catch(() => undefined);
      }
      const machine = { sandbox, lastUsed: Date.now(), busy: 1 };
      this.live.set(id, machine);
      return machine;
    } finally {
      this.opening -= 1;
      this.changed();
    }
  }

  /** Wake whatever waits for room: a VM went idle, stopped, or finished starting. */
  private changed(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }

  async run(id: string, root: string, argv: readonly string[], cwd: string, timeoutMs: number): Promise<RunResult> {
    const machine = await this.machine(id, root);
    const started = performance.now();
    try {
      const out = await machine.sandbox.execWith(argv[0]!, (b) => b.args([...argv.slice(1)]).cwd(cwd).timeout(timeoutMs));
      return { stdout: out.stdout(), stderr: out.stderr(), exitCode: out.code, timedOut: false,
        durationMs: Math.round(performance.now() - started) };
    } catch (error) {
      if (!(error instanceof ExecTimeoutError)) throw error;
      return { stdout: '', stderr: `timed out after ${timeoutMs} ms\n`, exitCode: 124, timedOut: true,
        durationMs: Math.round(performance.now() - started) };
    } finally {
      machine.busy -= 1;
      machine.lastUsed = Date.now();
      this.changed();
    }
  }

  async write(id: string, file: string, data: Buffer): Promise<boolean> {
    // A host-side write is not reliably seen by a running VM (a file renamed over another reads
    // back empty), so a running VM's workspace is written through its own agent.
    await this.stopping.get(id);
    const machine = this.live.get(id);
    if (!machine) return false;
    machine.busy += 1;
    try {
      await machine.sandbox.fs().write(file, data);
    } finally {
      machine.busy -= 1;
      machine.lastUsed = Date.now();
      this.changed();
    }
    return true;
  }

  private async stop(id: string): Promise<void> {
    const machine = this.live.get(id);
    if (!machine) return this.stopping.get(id);
    this.live.delete(id);
    const stopped = machine.sandbox.stop()
      .catch((error: unknown) =>
        this.log('warn', 'session VM did not stop cleanly', { session: id, error: String(error).slice(0, 300) }))
      .finally(() => {
        this.stopping.delete(id);
        this.changed();
      });
    this.stopping.set(id, stopped);
    return stopped;
  }

  async destroy(id: string): Promise<void> {
    await this.stop(id);
    try {
      const handle = await Sandbox.get(id);
      if (handle.status === 'running') await handle.kill();
      await Sandbox.remove(id);
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) throw error;
    }
  }

  /** Reserve a place for a VM about to start: stop the least recently used settled VM, or wait for one. */
  private async makeRoom(): Promise<void> {
    while (this.live.size + this.opening >= this.config.maxRunning) {
      // Only a VM idle for a while is stopped. One between two commands of a running turn is still in
      // use: stopping it would only make that turn start it again, and sessions would take turns
      // restarting each other's VMs.
      const settled = Date.now() - SETTLED_MS;
      const idle = [...this.live].filter(([, machine]) => machine.busy === 0 && machine.lastUsed <= settled)
        .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
      if (idle) await this.stop(idle[0]);
      else await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 1000).unref();  // a VM settles with no event to say so
      });
    }
    this.opening += 1;
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - this.config.idleStopMs;
    for (const [id, machine] of [...this.live]) {
      if (machine.busy === 0 && machine.lastUsed < cutoff) await this.stop(id);
    }
  }

  /** Stop every VM, for a worker shutting down. */
  async close(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }
}
