# ha-bridge (Home Assistant ↔ OpenClaw bridge)

This service is intended to sit between Home Assistant (HA) and the "brain" (OpenClaw + local LLMs).

## High-level design

- Expose a simple HTTP API (`POST /v1/conversation`) for HA or other clients.
- Translate incoming text + context into a request for the brain.
- Return natural language `reply_text` plus optional structured `actions` describing
  Home Assistant service calls.
- Optionally call HA's REST/WebSocket APIs directly when we want the bridge to
  execute actions itself (behind an explicit safety toggle).

At the moment, the `conversation` endpoint can work in three modes:

- **Stub mode** (no brain configured): returns a safe echo-style reply so you
  can wire up HA without affecting any real entities.
- **OpenClaw gateway mode (recommended)**: `OPENCLAW_BASE_URL` is set to the
  Gateway's OpenAI-compatible `/v1` base, and Home Assistant passes a Gateway
  token in the `Authorization: Bearer <token>` header via the custom
  component. The bridge calls the Gateway's `/v1/chat/completions` endpoint
  and expects a JSON object with `reply_text` and `actions` in the documented
  schema.
- **Direct LLM mode (legacy)**: `LLM_BASE_URL` and `LLM_API_KEY` are set to an
  OpenAI-compatible endpoint. The bridge talks directly to that endpoint
  instead of going through the OpenClaw Gateway.

## Quick start (OpenClaw Gateway mode)

Prerequisites:

- An OpenClaw Gateway running (for example at `http://<gateway-host>:18789/`).
- The Gateway's OpenAI-compatible HTTP surface enabled:
  - `gateway.http.endpoints.chatCompletions.enabled = true` in
    `~/.openclaw/openclaw.json`.
- A Home Assistant instance.

Steps (high level):

1. **Run `ha-bridge`** using Docker or Docker Compose so it listens on
   `http://<ha-bridge-host>:8080`.
2. **Install the custom component** by copying
   `homeassistant_custom/openclaw_conversation/` into your HA config as
   `custom_components/openclaw_conversation/` and restarting HA.
3. In HA, add the **OpenClaw Conversation Agent** integration and set:
   - **Bridge URL**: `http://<ha-bridge-host>:8080`
   - **Gateway token**: your OpenClaw Gateway bearer token.
4. In **Settings → Voice Assistants**, select the OpenClaw Conversation
   agent for the desired Assist pipeline.
5. Test with a simple utterance like "What is your name?" from Assist to
   verify the end-to-end path.

## Endpoints

### `GET /healthz`

Basic health check.

### `POST /v1/conversation`

Request body (example):

```json
{
  "text": "turn on the kitchen lights",
  "conversation_id": "optional-conversation-id",
  "user": { "id": "user123", "name": "Brian" },
  "room": { "id": "kitchen", "name": "Kitchen" },
  "entities": [
    { "entity_id": "light.kitchen_main", "name": "Kitchen Main Light" }
  ],
  "source": "home-assistant",
  "metadata": { "pipeline": "default" }
}
```

Response (shape):

```json
{
  "reply_text": "Stub reply or model reply...",
  "conversation_id": "optional-conversation-id",
  "actions": [
    {
      "type": "ha_service",
      "service": "light.turn_on",
      "target": { "entity_id": ["light.kitchen_main"] },
      "data": { "brightness": 200 }
    }
  ],
  "executed_actions": [
    {
      "action": { "service": "light.turn_on", "entity_id": "light.kitchen_main" },
      "result": [ /* raw HA service response */ ]
    }
  ],
  "action_errors": [
    {
      "action": { "service": "light.turn_on" },
      "error": "HA_SERVICE_ERROR",
      "status": 400,
      "body": "..."
    }
  ],
  "debug": {
    "source": "home-assistant",
    "received_entities": [
      { "entity_id": "light.kitchen_main", "name": "Kitchen Main Light" }
    ],
    "metadata": { "pipeline": "default" },
    "openclaw_base_url": "http://openclaw-gateway:8080",
    "ha_configured": true
  }
}
```

The `actions` array is what the brain *asked* to do. The `executed_actions` and
`action_errors` arrays describe what the bridge actually tried to do against
Home Assistant.

Auth between HA and this service, and between the service and OpenClaw/LLMs,
is handled via environment variables and headers:

- **HA → ha-bridge**: the Home Assistant custom component forwards any
  configured "API key" as `Authorization: Bearer <token>` on `/v1/conversation`
  calls. In the OpenClaw-first flow, this value should be your **Gateway
  token**.
- **ha-bridge → OpenClaw Gateway**: when `OPENCLAW_BASE_URL` is set, the
  bridge uses that URL (for example `http://gateway-host:18789/v1`) and sends
  the same token as a bearer token when calling `/v1/chat/completions`.

A safety flag (`EXECUTE_HA_ACTIONS`) controls whether actions are actually
sent to Home Assistant.

For bridge-side debugging, you can enable more verbose logging of outbound
LLM calls by setting:

```bash
DEBUG_BRIDGE=true
```

This will log each `/v1/chat/completions` call (URL + model id) without
changing behavior.

## Home Assistant custom component (HACS-friendly)

This repo ships a minimal Home Assistant integration under
`custom_components/openclaw_conversation/` that exposes this bridge as a
conversation agent.

### Install via HACS (recommended)

1. Make sure [HACS](https://hacs.xyz/) is installed in your Home Assistant.
2. In HACS, go to **Integrations → Custom repositories** and add this repo:
   - URL: `https://github.com/PrayerfulDrop/HA-OpenClaw-Conversation-Agent-and-Bridge`
   - Category: **Integration**
3. Install the **OpenClaw Conversation Agent** integration from HACS.
4. Restart Home Assistant.

Then in HA:

1. In **Settings → Devices & services → Integrations**, add **OpenClaw
   Conversation Agent**.
2. Set the **Bridge URL** to the URL where this service is reachable, e.g.
   `http://ha-bridge:8080` or `http://llm-home:8080` depending on where you
   run the container.
3. In the agent config, paste your **Gateway token** into the
   **Gateway token** field; this value is forwarded as a bearer token to the
   bridge.
4. In **Settings → Voice Assistants**, select the OpenClaw Conversation agent
   as the conversation engine for the relevant Assist pipelines.

### Manual install (without HACS)

1. Copy `custom_components/openclaw_conversation/` into your Home Assistant
   config directory as `custom_components/openclaw_conversation/`.
2. Restart Home Assistant.
3. Follow the same configuration steps as above (Bridge URL + Gateway token,
   then select the agent in Voice Assistants).

From there, any Assist request that uses this agent will be forwarded to
`/v1/conversation` on the bridge, and the `reply_text` will be spoken back
by Home Assistant.

## Docker Compose example (OpenClaw Gateway mode)

Minimal example for running `ha-bridge` alongside an OpenClaw Gateway and
Home Assistant on the same Docker network:

```yaml
version: "3.9"

services:
  ha-bridge:
    build: .
    container_name: ha-bridge
    environment:
      # OpenClaw Gateway OpenAI-compatible HTTP surface
      # Make sure `gateway.http.endpoints.chatCompletions.enabled` is true.
      - OPENCLAW_BASE_URL=http://openclaw-gateway:18789/v1

      # Optional but recommended: dedicated HA investigative agent
      # When set, ha-bridge will prefer this model when calling the
      # OpenClaw Gateway (unless HA explicitly overrides it via
      # metadata.openclaw.agent_model).
      - OPENCLAW_AGENT_MODEL=openclaw/ha-bridge

      # Home Assistant base URL and long-lived access token
      - HOME_ASSISTANT_BASE_URL=http://homeassistant:8123
      - HOME_ASSISTANT_TOKEN=YOUR_HA_LONG_LIVED_TOKEN

      # Optional: explicitly set the model id for the Gateway
      # When OPENCLAW_BASE_URL is set, the bridge ignores LLM_MODEL and
      # instead uses, in order of precedence:
      #   1) metadata.openclaw.agent_model
      #   2) OPENCLAW_AGENT_MODEL
      #   3) openclaw/default

      # Only enable this once you are confident in the safety profile.
      - EXECUTE_HA_ACTIONS=true

    ports:
      - "8080:8080"
    restart: unless-stopped
    # networks:
    #   - your_shared_network

# networks:
#   your_shared_network:
#     external: true
```

In this setup:

- The Gateway is reachable inside Docker as `http://openclaw-gateway:18789`.
- Home Assistant is reachable as `http://homeassistant:8123`.
- The OpenClaw Conversation custom component in HA is configured with:
  - **Bridge URL**: `http://ha-bridge:8080`
  - **API key**: your OpenClaw **Gateway token** (forwarded to the bridge and
    then to the Gateway as a bearer token).

If you prefer a one-off `docker run` instead of Compose, the equivalent is
roughly:

```bash

```bash
docker run -d --name ha-bridge --restart unless-stopped \
  -p 8080:8080 \
  -e OPENCLAW_BASE_URL=http://openclaw-gateway:18789/v1 \
  -e OPENCLAW_AGENT_MODEL=openclaw/ha-bridge \
  -e HOME_ASSISTANT_BASE_URL=http://homeassistant:8123 \
  -e HOME_ASSISTANT_TOKEN=YOUR_HA_LONG_LIVED_TOKEN \
  -e EXECUTE_HA_ACTIONS=true \
  ha-bridge:local
```

## Configuring the OpenClaw HA agent (reproducible setup)

The bridge is designed to talk to a dedicated OpenClaw agent for
Home Assistant and infrastructure‑adjacent questions. The recommended
convention is:

- **Agent id:** `ha-bridge`
- **Model string:** `openclaw/ha-bridge`

### One-time agent setup on the OpenClaw host

Run these commands on the machine where the OpenClaw Gateway is running:

```bash
# Create a dedicated HA agent that reuses the main workspace
openclaw agents add ha-bridge \
  --workspace ~/.openclaw/workspace \
  --non-interactive || true
```

This creates an `ha-bridge` agent that shares the same workspace as your
main agent. You can confirm it with:

```bash
openclaw agents list
```

### Pointing ha-bridge at the HA agent

With the agent in place, set `OPENCLAW_AGENT_MODEL` for the ha-bridge
container:

```yaml
environment:
  - OPENCLAW_BASE_URL=http://openclaw-gateway:18789/v1
  - OPENCLAW_AGENT_MODEL=openclaw/ha-bridge
  - HOME_ASSISTANT_BASE_URL=http://homeassistant:8123
  - HOME_ASSISTANT_TOKEN=YOUR_HA_LONG_LIVED_TOKEN
  - EXECUTE_HA_ACTIONS=true
```

The effective model used for Gateway calls will then be:

1. `metadata.openclaw.agent_model` (if Home Assistant explicitly sets it)
2. `OPENCLAW_AGENT_MODEL` (`openclaw/ha-bridge` in this example)
3. `openclaw/default` fallback

If `OPENCLAW_AGENT_MODEL` is unset, behavior is unchanged from prior
versions (the default `openclaw/default` model is used when
`OPENCLAW_BASE_URL` is configured).

### Manual recovery if automatic setup fails

If you ever suspect the HA agent was not created correctly, you can
re-run the one‑time setup step and restart ha-bridge:

```bash
openclaw agents add ha-bridge \
  --workspace ~/.openclaw/workspace \
  --non-interactive || true

docker restart ha-bridge
```

Then test from Home Assistant Assist with a simple utterance such as
"What is your name?". The request should route through the
`openclaw/ha-bridge` model when `OPENCLAW_AGENT_MODEL` is set.

## Generic investigative questions (no per-scenario stubs)

The bridge is intentionally **generic**: once it is pointed at an OpenClaw
Gateway, you should not need to add new HTTP endpoints or hard-coded
"scenario" handlers here to support questions like
"what cron jobs are running on &lt;server&gt;?" or
"how many Wi‑Fi devices are on the network?".

Instead, the behavior is:

- The bridge forwards text + lightweight context to the Gateway via the
  OpenAI-compatible `/v1/chat/completions` surface.
- A configured OpenClaw agent (for example `openclaw/ha-bridge`) decides
  how to answer, including when to use tools like `exec` to run
  **read-only diagnostics** against your own infrastructure.
- The bridge enforces the security split:
  - Requests that look like **HA control** ("turn on", "set", "lock",
    "unlock", "open", "close", "arm", "disarm", etc.) are routed through
    `/v1/conversation` in **control mode** and may result in Home Assistant
    service calls when `EXECUTE_HA_ACTIONS=true`.
  - Requests that look like **read-only / investigative** questions (plain
    questions that don’t start with imperative verbs) are handled in an
    **info-only** mode: the agent may run read-only checks (including SSH
    commands via OpenClaw tools), but the bridge will not execute HA actions
    for them.

### OpenClaw-side requirements (reproducible setup)

To make this generic behavior work on any OpenClaw deployment:

1. **Enable the Gateway HTTP chat-completions surface**

   In `~/.openclaw/openclaw.json`:

   ```json5
   {
     gateway: {
       http: {
         endpoints: {
           chatCompletions: { enabled: true },
         },
       },
     },
   }
   ```

2. **Describe servers in config, not code**

   In the agent workspace used by the Gateway (for example the default
   `~/.openclaw/workspace`), add a config file such as
   `config/ha_servers.json` (you can start from
   `config/ha_servers.example.json` in this repo):

   ```json
   {
     "llm-home": {
       "ssh": "user@llm-home.local",
       "role": "llm-server"
     },
     "media-server": {
       "ssh": "user@media-server.local",
       "role": "media-server"
     }
   }
   ```

   The HA agent is expected to read this configuration (or equivalent
   context such as TOOLS.md) and decide which host to inspect when the
   user asks about a particular server.

3. **Use generic, read-only helpers for inspection**

   This workspace also provides a generic helper script:

   ```bash
   scripts/ha_server_inspect.sh <label> <ssh_target>
   ```

   The HA agent should call this script via OpenClaw's exec/SSH tools to
   gather information about cron, systemd timers, OS, and (optionally) apt
   upgradable packages on a host. The script is intentionally **read-only**
   and should not be modified to perform updates or restarts.

4. **Ask before wiring new hosts**

   If a user asks about a host that is not present in
   `config/ha_servers.json`, the HA agent should:

   - Explain that it does not yet have read-only access to that host.
   - Ask the user if they want to wire it up.
   - Provide concrete setup instructions (for example, running a small
     helper script on the OpenClaw host to add the host to
     `config/ha_servers.json`), rather than attempting to modify SSH or
     config directly via the HA pathway.

With this setup, new investigative questions routed through HA → ha-bridge →
OpenClaw do **not** require any new per-scenario HTTP handlers in this repo;
they are handled generically by the OpenClaw agent and its toolset, with
per-host details living in workspace config instead of code.
