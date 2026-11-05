# Third-party notices

The Apache-2.0 license in the repository root covers original project code and documentation. The following third-party material retains its original rights and notices.

## microsandbox

- Where: installed from npm (`microsandbox` and its platform package `@superradcompany/microsandbox-<platform>`, pinned in `worker/package-lock.json`) into the sandbox worker image, with its `msb` runtime and the `libkrunfw` library; not vendored in this repository.
- Source: [superradcompany/microsandbox](https://github.com/superradcompany/microsandbox).
- Copyright: the microsandbox authors.
- License: Apache-2.0.

## libkrunfw (in microsandbox's runtime)

- Where: `lib/libkrunfw.*` in the microsandbox platform package, so in a built worker image; not vendored in this repository.
- Source: [superradcompany/libkrunfw](https://github.com/superradcompany/libkrunfw), microsandbox's fork of [containers/libkrunfw](https://github.com/containers/libkrunfw), at the revision microsandbox 0.7.13 pins.
- License: the library is LGPL-2.1-only; the Linux kernel it bundles as the VMs' guest kernel is GPL-2.0-only.
- Distributing a built worker image distributes libkrunfw in binary form, which its license requires to be accompanied by the source of the library and of the bundled kernel. Building the images locally, as `make images` does, distributes nothing.

## openai-agent-substrate harness and UI

- Files: `harness/` (the shared agent harness and its UI page), `apps/sre/agent/lib/findings.py` and `apps/sre/agent/skills/kubernetes-triage/scripts/triage.py`.
- Source: openai-agent-substrate, adapted from Agent Substrate Actors to sandbox worker sessions. Files that keep its copyright line are those copies.
- Copyright: 2026 openai-agent-substrate contributors.
- License: Apache-2.0.

## OpenAI architecture diagram

- File: `docs/assets/harness-separate-from-compute.png`.
- Source and attribution: OpenAI, [Sandbox Agents guide](https://developers.openai.com/api/docs/guides/agents/sandboxes), “Harness separate from compute” diagram.
- The image was supplied for inclusion in this project's README, as it was for openai-agent-substrate, and is reproduced without modification.
- The diagram and associated trademarks remain subject to their original rights and terms. They are excluded from the project's Apache-2.0 license grant.

Dependencies installed through `uv.lock` and `worker/package-lock.json` retain their respective licenses; they are not vendored into this repository.
