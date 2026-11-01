# Third-party notices

The Apache-2.0 license in the repository root covers original project code and documentation. The following third-party material retains its original rights and notices.

## Microsoft eXecution Container (MXC)

- Where: installed from npm (`@microsoft/mxc-sdk`, pinned in `worker/package-lock.json`) into the sandbox worker image, with its native `lxc-exec` executor; not vendored in this repository.
- Source: [microsoft/mxc](https://github.com/microsoft/mxc).
- Copyright: Microsoft Corporation.
- License: MIT. The package's license ships in the image at `/app/node_modules/@microsoft/mxc-sdk/LICENSE.md`.

## openai-agent-substrate harness and UI

- Files: `harness/` (the shared agent harness and its UI page), `examples/sre/agent/lib/findings.py` and `examples/sre/agent/skills/kubernetes-triage/scripts/triage.py`.
- Source: openai-agent-substrate, adapted from Agent Substrate Actors to MXC sessions. Files that keep its copyright line are those copies.
- Copyright: 2026 openai-agent-substrate contributors.
- License: Apache-2.0.

## OpenAI architecture diagram

- File: `docs/assets/harness-separate-from-compute.png`.
- Source and attribution: OpenAI, [Sandbox Agents guide](https://developers.openai.com/api/docs/guides/agents/sandboxes), “Harness separate from compute” diagram.
- The image was supplied for inclusion in this project's README, as it was for openai-agent-substrate, and is reproduced without modification.
- The diagram and associated trademarks remain subject to their original rights and terms. They are excluded from the project's Apache-2.0 license grant.

Dependencies installed through `uv.lock` and `worker/package-lock.json` retain their respective licenses; they are not vendored into this repository.
