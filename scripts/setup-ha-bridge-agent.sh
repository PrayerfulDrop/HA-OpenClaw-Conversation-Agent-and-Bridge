#!/usr/bin/env bash
set -euo pipefail

# Simple helper to ensure an `ha-bridge` agent exists and points at the
# main workspace. Safe to run multiple times.

AGENT_ID="ha-bridge"
WORKSPACE_DIR="${HOME}/.openclaw/workspace"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw CLI not found on PATH; please install OpenClaw first." >&2
  exit 1
fi

# Create the agent if missing. --non-interactive avoids prompts; the
# command is idempotent when combined with `|| true`.
openclaw agents add "${AGENT_ID}" \
  --workspace "${WORKSPACE_DIR}" \
  --non-interactive || true

# Show the resulting agent list for quick verification.
echo
openclaw agents list
