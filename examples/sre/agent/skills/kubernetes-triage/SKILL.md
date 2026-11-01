---
name: kubernetes-triage
description: Find unhealthy workloads in a Kubernetes namespace, explain each root cause from recorded kubectl evidence, and write checked findings with proposed fixes.
---

# Kubernetes triage

Work from evidence. A plain kubectl read (no pipes, redirections, quotes or `$`)
and every `pod_logs` excerpt are recorded by the sandbox worker and saved under
`evidence/`; read those files with the shell rather than relying on the output
you saw scroll past. Logs come only from `pod_logs`, as excerpts.

1. **Survey.** For each namespace in scope run
   `kubectl get pods -n NAMESPACE -o wide`,
   `kubectl get deployments -n NAMESPACE -o wide`,
   `kubectl get replicasets -n NAMESPACE -o wide` and
   `kubectl get events -n NAMESPACE --sort-by=.lastTimestamp`.
   The ReplicaSets show what changed: each revision of a deployment, its age
   and its images.
2. **Pick suspects.** Run
   `python3 <skill-root>/scripts/triage.py evidence/*.txt`. It reads saved
   `kubectl get pods -o wide` output and prints each pod that is not ready,
   is waiting, or has restarted, with the evidence file it came from.
3. **Drill in.** For each suspect, `kubectl describe pod NAME -n NAMESPACE` and
   read its log with `pod_logs` (pod NAME or `deploy/NAME`). For a container
   that restarts, also read `previous=true`: the current container may not have
   logged anything yet. If the excerpt withheld what you need, call it again
   with `match` set to the text you are looking for, or `since` (such as `15m`)
   for recent lines only. For a deployment, run
   `kubectl rollout history deployment/NAME -n NAMESPACE` to see its revisions,
   and describe it when replicas or rollout state matter.
4. **Check the runbooks.** `ls runbooks/` and read the one for the affected
   service; it often names the configuration a service needs.
5. **Diagnose.** Match the evidence to a cause:

   | Symptom in the evidence | Usual cause |
   | --- | --- |
   | `CrashLoopBackOff`, exit code 1, an error in the previous logs | The program fails at start: configuration, a dependency, or a bug |
   | `ErrImagePull` / `ImagePullBackOff`, "not found" or "manifest unknown" | A wrong image name or tag, or a missing registry credential |
   | `OOMKilled`, exit code 137 | The memory limit is too low for the workload |
   | `Pending` with `FailedScheduling` | Requests exceed free capacity, or selectors and taints do not match |
   | Running but not ready, `Unhealthy` probe events | The readiness probe fails: wrong port or path, or a slow start |

   State only what the evidence shows. If the cause is uncertain, say what
   would confirm it. Note the other causes you considered and the evidence
   that ruled each out.
6. **Write the outputs.**
   - `output/findings.md`: one section per affected workload with the problem,
     the cause, the evidence (quoted) and the proposed fix. List healthy
     workloads briefly.
   - `output/findings.json`, written last:

     ```json
     {"findings": [{
       "resource": "deployment/payments-ledger", "namespace": "payments",
       "problem": "Image not found", "cause": "...",
       "ruled_out": ["Registry credentials: the pull failed with manifest unknown, not unauthorized"],
       "fix": {
         "summary": "Roll back to revision 7, the last image that ran",
         "precheck": ["kubectl rollout history deployment/payments-ledger -n payments"],
         "commands": ["kubectl rollout undo deployment/payments-ledger -n payments --to-revision=7"],
         "verify": ["kubectl rollout status deployment/payments-ledger -n payments"],
         "rollback": ["kubectl rollout undo deployment/payments-ledger -n payments --to-revision=8"],
         "risk": "Restarts the ledger's pods; writes queue while it rolls out."
       },
       "evidence": [{"file": "evidence/004-kubectl-describe-pod-....txt", "quote": "exact text from that file"}]
     }]}
     ```

     `problem` is a short label, at most five words, such as
     `CrashLoopBackOff`, `Image not found` or `Readiness probe failing`; the
     cause and the fix go in their own fields. `ruled_out` lists the other
     causes you considered, each with what ruled it out.

     The fix is for a person to run, so write it as commands they can paste:
     `precheck` confirms the state the fix assumes, `commands` makes the change,
     `verify` shows it worked and `rollback` undoes it. Use the revisions and
     names the evidence shows (a rollback goes to a revision `rollout history`
     listed). When the fix is not a command, such as restoring a Secret the
     agent cannot read, say so in `summary` and leave `commands` empty rather
     than guessing. `risk` is one sentence on what the change disrupts.

     Each finding needs at least one evidence entry, citing a file the worker
     saved. A quote is text copied exactly from that file, without the line
     number prefix of a log excerpt; whitespace differences are allowed.
     Runbooks are context, not evidence.
7. Reopen both files and confirm every quote appears in its evidence file, for
   example with `grep -F`. Fix any mismatch before you answer.
