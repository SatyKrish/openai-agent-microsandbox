// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// Which commands count as evidence. A command qualifies only when it is a plain
// kubectl read: no shell syntax that could change its output, and no flag that
// points kubectl at another server or identity. Its output then comes from the
// API server as the worker's own read-only identity, so the worker records it
// in a journal the containers cannot see, and the harness checks the agent's
// quotes against that copy rather than anything the agent could edit.

const READ_VERBS = new Set(['get', 'describe', 'logs', 'events', 'top', 'explain', 'api-resources', 'api-versions',
  'version']);
// Flags that would read from somewhere other than the in-cluster API as the worker's identity.
const FORBIDDEN = new Set(['--kubeconfig', '--server', '-s', '--token', '--as', '--as-group', '--as-uid', '--user',
  '--cluster', '--context', '--certificate-authority', '--client-certificate', '--client-key',
  '--insecure-skip-tls-verify', '--tls-server-name', '--username', '--password', '--cache-dir', '--profile',
  '--profile-output', '--raw', '-f', '--filename', '-k', '--kustomize']);
// Words a plain command line may contain: no quotes, globs, expansions, redirections or separators.
const PLAIN = /^[A-Za-z0-9_./:=,@+%-]+$/;
const SHELLS = new Set(['sh', 'bash', '/bin/sh', '/bin/bash', '/usr/bin/bash']);
// Global flags that take the next word as their value, so it is not the verb.
const VALUED = new Set(['-n', '--namespace', '--request-timeout', '-v', '--v']);

/** The kubectl words of a plain read, or null. */
export function kubectlRead(argv: readonly string[]): string[] | null {
  let words: string[];
  if (argv[0] === 'kubectl') {
    words = [...argv];
  } else if (argv.length === 3 && SHELLS.has(argv[0] ?? '') && (argv[1] === '-c' || argv[1] === '-lc')) {
    const line = (argv[2] ?? '').trim();
    if (!/^[^\n\t]*$/.test(line)) return null;
    words = line.split(/ +/);
  } else {
    return null;
  }
  if (words[0] !== 'kubectl' || words.length < 2 || !words.every((word) => PLAIN.test(word))) return null;
  let verb: string | undefined;
  for (let index = 1; index < words.length && verb === undefined; index += 1) {
    const word = words[index]!;
    if (VALUED.has(word)) index += 1;
    else if (!word.startsWith('-')) verb = word;
  }
  if (!verb || !READ_VERBS.has(verb)) return null;
  for (const word of words) {
    if (FORBIDDEN.has(word.split('=')[0] ?? '')) return null;
  }
  return words;
}

/** A file name for the workspace copy: evidence/NNN-kubectl-get-pods-n-payments.txt */
export function evidenceName(seq: number, words: readonly string[]): string {
  let slug = words.join('-').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > 80) {
    // Cut at a word boundary, so a name never ends in half a namespace.
    slug = slug.slice(0, 81);
    slug = slug.slice(0, slug.lastIndexOf('-') > 40 ? slug.lastIndexOf('-') : 80);
  }
  slug = slug.replace(/[-.]+$/, '');
  return `evidence/${String(seq).padStart(3, '0')}-${slug || 'kubectl'}.txt`;
}
