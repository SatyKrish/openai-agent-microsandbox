# openai-agent-mxc

OpenAI Agents SDK sandbox provider for an MXC sandbox worker on Kubernetes.
`MXCSandboxClient` implements the SDK's `BaseSandboxClient`; each session is a
workspace on the worker, and every command runs in a fresh Microsoft eXecution
Container there. See the repository README.
