#!/bin/sh
# Copyright 2026 openai-agent-microsandbox contributors
# SPDX-License-Identifier: Apache-2.0
#
# The worker container starts as root for two things only, then runs as 10001
# with no capabilities, no other groups and no_new_privs, for good:
# - KVM: the container's own /dev/kvm node (a privileged container gets its own
#   copies of the node's device files) goes to the worker's group, so the VMs'
#   host processes can open it;
# - the volume: microsandbox refuses a store where another account could swap
#   paths, and a fresh volume is group- or world-writable, so it becomes the
#   worker's alone.
set -eu
uid=10001
if [ "$(id -u)" = 0 ]; then
  chgrp "$uid" /dev/kvm && chmod 0660 /dev/kvm
  chown "$uid:$uid" "$DATA_DIR" && chmod 0700 "$DATA_DIR"
  exec setpriv --reuid="$uid" --regid="$uid" --clear-groups --no-new-privs \
    --inh-caps=-all --bounding-set=-all -- "$@"
fi
exec "$@"
