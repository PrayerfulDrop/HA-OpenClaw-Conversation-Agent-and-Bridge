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

      # Home Assistant base URL and long-lived access token
      - HOME_ASSISTANT_BASE_URL=http://homeassistant:8123
      - HOME_ASSISTANT_TOKEN=YOUR_HA_LONG_LIVED_TOKEN

      # Optional: explicitly set the model id for the Gateway
      # (default is `openclaw/default` when OPENCLAW_BASE_URL is set)
      - LLM_MODEL=openclaw/default

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
docker run -d --name ha-bridge --restart unless-stopped \
  -p 8080:8080 \
  -e OPENCLAW_BASE_URL=http://openclaw-gateway:18789/v1 \
  -e HOME_ASSISTANT_BASE_URL=http://homeassistant:8123 \
  -e HOME_ASSISTANT_TOKEN=YOUR_HA_LONG_LIVED_TOKEN \
  -e EXECUTE_HA_ACTIONS=true \
  ha-bridge:local
```
