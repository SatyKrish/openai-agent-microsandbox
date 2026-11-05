# openai-agent-mxc

OpenAI Agents SDK sandbox provider for a paired sandbox worker on Kubernetes.
`WorkerSandboxClient` implements the SDK's `BaseSandboxClient`; each session is a
workspace on the worker and a microVM there (microsandbox) that runs its commands.
See the repository README.
