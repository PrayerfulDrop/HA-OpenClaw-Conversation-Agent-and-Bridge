require('dotenv').config();

const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Optional configuration for later wiring
const OPENCLAW_BASE_URL = process.env.OPENCLAW_BASE_URL || null;
const HA_BASE_URL = process.env.HOME_ASSISTANT_BASE_URL || null;
const HA_TOKEN = process.env.HOME_ASSISTANT_TOKEN || null;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || null;

// Safety: require explicit opt-in before executing HA actions
const EXECUTE_HA_ACTIONS =
  process.env.EXECUTE_HA_ACTIONS === '1' ||
  process.env.EXECUTE_HA_ACTIONS === 'true';

// Basic health check
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

/**
 * Call into the "brain" (OpenClaw / LLM provider).
 *
 * Behavior:
 * - If LLM env vars are not set, fall back to a safe stub implementation.
 * - Otherwise, call an OpenAI-compatible chat completion endpoint and
 *   expect a JSON object with { reply_text, actions }.
 *
 * NOTE: `gatewayToken` is plumbed through from Home Assistant and will
 * eventually be used to talk to the OpenClaw gateway directly instead of a
 * raw LLM endpoint. For now it is accepted but unused so we can migrate in
 * small, safe steps.
 */
async function callBrain({ text, user, room, entities, conversationId, source, metadata, gatewayToken }) {
  const openclawBaseUrl = process.env.OPENCLAW_BASE_URL;
  const llmBaseUrl = openclawBaseUrl || process.env.LLM_BASE_URL;
  // Prefer a per-request gateway token when present; fall back to a static
  // API key for legacy setups that still talk directly to an LLM provider.
  const llmApiKey = gatewayToken || process.env.LLM_API_KEY;
  const llmModel = openclawBaseUrl
    ? 'openclaw/default'
    : process.env.LLM_MODEL || 'gpt-4.1-mini';

  // Fallback stub if no LLM is configured yet.
  if (!llmBaseUrl) {
    const replyText = `Stub reply (no LLM configured): I heard "${text}" from ${
      user?.name || user?.id || 'an unknown user'
    }${room?.name ? ` in the ${room.name}` : ''}.`;

    return {
      replyText,
      actions: [],
      conversationId: conversationId || null,
      llm_used: false,
    };
  }

  const systemPrompt = `You are the home automation brain for a smart home.
You receive user utterances plus structured context from Home Assistant
(user info, room, visible entities, metadata) as well as an optional
snapshot of Home Assistant entities and states (ha_snapshot).

Use ha_snapshot to answer questions about the current state of the home
(lights that are on, doors open, scenes, etc.). If ha_snapshot is missing
or does not contain the requested information, say so instead of
hallucinating.

Only treat an entity as unavailable if its 'state' field is literally the
string "unavailable". A state of "off" means the entity is available but
currently off, and you can still send control actions to it.

Only include non-empty 'actions' when the user explicitly asks to change
something (turn on/off, open/close, start/stop, etc.). For pure questions,
leave 'actions' as an empty array.

For now, when creating 'ha_service' actions, you should restrict yourself
to safe domains like lights, switches, scenes, media players, fans, and
climate ("light.*", "switch.*", "scene.*", "media_player.*", "fan.*",
"climate.*"). Do NOT create actions for high-risk domains like locks or
alarm control panels ("lock.*", "alarm_control_panel.*").

For climate.* entities, commands like "set upstairs HVAC to cool and 72"
should result in a 'climate.set_temperature' action (optionally combined
with 'climate.set_hvac_mode'), with the appropriate entity_id, hvac_mode,
and temperature, even if the current state is "off".

You MUST respond with a single JSON object only, no extra text.
Schema:
{
  "reply_text": string,              // what to say back to the user
  "actions": [                       // optional Home Assistant service calls
    {
      "type": "ha_service",
      "service": "domain.service", // e.g. "light.turn_on"
      "target": {                   // optional
        "entity_id": ["light.kitchen_main"]
      },
      "entity_id": "light.kitchen_main",  // optional shorthand
      "data": { ... }                       // service data
    }
  ]
}

Keep actions minimal and safe by default. If in doubt, ask a clarifying question in reply_text and return an empty actions array.`;

  const haSnapshot = await fetchHaSnapshot();

  const userPayload = {
    text,
    user,
    room,
    entities,
    source,
    metadata,
    conversation_id: conversationId || null,
    ha_snapshot: haSnapshot,
    // NOTE: we intentionally do *not* include the gateway token here. The
    // token is for talking to OpenClaw, not for the upstream LLM, and
    // should never be exposed to third-party providers.
  };

  const url = `${llmBaseUrl.replace(/\/$/, '')}/chat/completions`;

  const body = {
    model: llmModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
    temperature: 0.2,
  };

  try {
    console.log('callBrain ->', url, 'model=', llmModel);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(llmApiKey ? { Authorization: `Bearer ${llmApiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const textBody = await resp.text();
      console.error('LLM call failed', resp.status, textBody);
      throw new Error(`LLM error: ${resp.status}`);
    }

    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content;

    if (!content || typeof content !== 'string') {
      throw new Error('LLM response missing message content');
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      console.error('Failed to parse LLM JSON content', err, content);
      throw new Error('LLM response was not valid JSON');
    }

    const replyText =
      typeof parsed.reply_text === 'string'
        ? parsed.reply_text
        : `Sorry, I could not interpret that request.`;

    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];

    return {
      replyText,
      actions,
      conversationId: conversationId || null,
      llm_used: true,
    };
  } catch (err) {
    console.error('Error calling brain LLM, falling back to stub', err);

    const replyText = `Stub fallback (LLM error): I heard "${text}" from ${
      user?.name || user?.id || 'an unknown user'
    }${room?.name ? ` in the ${room.name}` : ''}.`;

    const fallbackReply = openclawBaseUrl
      ? 'I could not reach the OpenClaw brain just now. ' +
        'Please check that the OpenClaw Conversation Agent in Home Assistant has the correct Bridge URL and Gateway token, ' +
        'and that the Gateway\'s /v1/chat/completions HTTP endpoint is enabled. '
      : replyText;

    return {
      replyText: fallbackReply,
      actions: [],
      conversationId: conversationId || null,
      llm_used: false,
    };
  }
}

const HA_SNAPSHOT_TTL_MS = 5000; // 5 seconds
let lastHaSnapshot = null;
let lastHaSnapshotTs = 0;

/**
 * Fetch a snapshot of Home Assistant entities for context.
 *
 * We intentionally only include a small subset of fields to keep prompts sane.
 */
async function fetchHaSnapshot() {
  if (!HA_BASE_URL || !HA_TOKEN) {
    return null;
  }

  const now = Date.now();
  if (lastHaSnapshot && now - lastHaSnapshotTs < HA_SNAPSHOT_TTL_MS) {
    return lastHaSnapshot;
  }

  try {
    const url = `${HA_BASE_URL.replace(/\/$/, '')}/api/states`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('Failed to fetch HA states', resp.status, text.slice(0, 500));
      return null;
    }

    const states = await resp.json();
    if (!Array.isArray(states)) {
      return null;
    }

    const allowedDomains = new Set([
      'light',
      'switch',
      'fan',
      'climate',
      'cover',
      'lock',
      'scene',
      'script',
      'automation',
      'media_player',
      'alarm_control_panel',
      'input_boolean',
    ]);

    // Summarize entities to keep the payload small-ish.
    const entities = states
      .map((s) => {
        const entityId = s.entity_id || '';
        const [domain] = entityId.split('.');
        const attrs = s.attributes || {};
        return {
          entity_id: entityId,
          domain,
          friendly_name: attrs.friendly_name || null,
          area_id: attrs.area_id || null,
          room_name: attrs.room_name || null,
          state: s.state,
        };
      })
      .filter((e) => allowedDomains.has(e.domain));

    const snapshot = { entities };
    lastHaSnapshot = snapshot;
    lastHaSnapshotTs = now;
    return snapshot;
  } catch (err) {
    console.error('Error fetching HA snapshot', err);
    return null;
  }
}

/**
 * Optionally execute HA service calls described in the `actions` array.
 *
 * Action schema (initial draft):
 * {
 *   type: 'ha_service',
 *   service: 'light.turn_on',
 *   target: { entity_id: ['light.kitchen_main'] }, // or entity_id: 'light.kitchen_main'
 *   data: { brightness: 200 }
 * }
 */
async function executeActions(actions) {
  const executed = [];
  const errors = [];

  if (!Array.isArray(actions) || actions.length === 0) {
    return { executed, errors };
  }

  if (!EXECUTE_HA_ACTIONS) {
    errors.push({
      error: 'EXECUTION_DISABLED',
      message:
        'EXECUTE_HA_ACTIONS is not enabled; actions were not sent to Home Assistant.',
    });
    // We still return the actions in the response so you can see what
    // would have happened, but nothing is executed.
    return { executed, errors };
  }

  if (!HA_BASE_URL || !HA_TOKEN) {
    // We don't fail the whole request if HA isn't configured; just report.
    errors.push({
      error: 'HOME_ASSISTANT_NOT_CONFIGURED',
      message: 'HA_BASE_URL or HA_TOKEN not set; skipping action execution.',
    });
    return { executed, errors };
  }

  const allowedExecDomains = new Set([
    'light',
    'switch',
    'scene',
    'script',
    'media_player',
    'fan',
    'climate',
  ]);

  for (const action of actions) {
    if (!action || action.type !== 'ha_service') {
      errors.push({
        action,
        error: 'UNSUPPORTED_ACTION_TYPE',
      });
      continue;
    }

    const { service, target, entity_id, data } = action;

    if (!service || typeof service !== 'string' || !service.includes('.')) {
      errors.push({
        action,
        error: 'INVALID_SERVICE',
      });
      continue;
    }

    const [domain, serviceName] = service.split('.');

    if (!allowedExecDomains.has(domain)) {
      errors.push({
        action,
        error: 'DOMAIN_NOT_ALLOWED',
      });
      continue;
    }
    const url = `${HA_BASE_URL.replace(/\/$/, '')}/api/services/${domain}/${serviceName}`;

    // Normalize targeting to entity_id only. If the model used target.entity_id
    // and did not set entity_id, use that as a fallback.
    let resolvedEntityId = entity_id;
    if (!resolvedEntityId && target && Array.isArray(target.entity_id)) {
      resolvedEntityId = target.entity_id;
    }

    const body = {
      ...(resolvedEntityId ? { entity_id: resolvedEntityId } : {}),
      ...(data || {}),
    };

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${HA_TOKEN}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        errors.push({
          action,
          error: 'HA_SERVICE_ERROR',
          status: resp.status,
          body: text,
        });
        continue;
      }

      const json = await resp.json().catch(() => null);
      executed.push({ action, result: json });
    } catch (err) {
      errors.push({
        action,
        error: 'HA_SERVICE_EXCEPTION',
        message: err?.message || String(err),
      });
    }
  }

  return { executed, errors };
}

/**
 * Generic conversation endpoint.
 *
 * This is intentionally NOT tied to Home Assistant specifics yet.
 * The idea is:
 * - HA (or another client) sends text + optional context
 * - We call the "brain" (OpenClaw / LLM) with that context
 * - We optionally execute actions against HA
 * - We return natural language plus structured details
 */
app.post('/v1/conversation', async (req, res) => {
  const {
    text,
    conversation_id: conversationId,
    user,
    room,
    entities,
    source,
    metadata,
  } = req.body || {};

  // Extract a bearer token, if present. In the new design this is expected
  // to be the OpenClaw gateway token passed through from Home Assistant via
  // the custom component.
  const authHeader = req.headers['authorization'] || '';
  let gatewayToken = null;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    gatewayToken = authHeader.slice(7).trim();
  }

  // Optional backwards-compatible shared-secret auth for direct-LLM setups.
  // When OPENCLAW_BASE_URL is set we deliberately skip this check and rely on
  // the Gateway token instead; in that mode BRIDGE_API_KEY is ignored.
  if (!OPENCLAW_BASE_URL && BRIDGE_API_KEY) {
    if (!gatewayToken || gatewayToken !== BRIDGE_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing required field: text' });
  }

  try {
    // Step 1: ask the brain what to do (currently stubbed).
    const brainResult = await callBrain({
      text,
      user,
      room,
      entities,
      conversationId,
      source,
      metadata,
      gatewayToken,
    });

    // Step 2: if there are actions, try to execute them against HA.
    const { executed, errors } = await executeActions(brainResult.actions);

    const response = {
      reply_text: brainResult.replyText,
      conversation_id: brainResult.conversationId,
      actions: brainResult.actions || [],
      executed_actions: executed,
      action_errors: errors,
      // Echo back some context for debugging
      debug: {
        source: source || 'unknown',
        received_entities: entities || [],
        metadata: metadata || {},
        openclaw_base_url: OPENCLAW_BASE_URL,
        ha_configured: Boolean(HA_BASE_URL && HA_TOKEN),
        execute_ha_actions: EXECUTE_HA_ACTIONS,
        auth_required: Boolean(BRIDGE_API_KEY),
      },
    };

    res.json(response);
  } catch (err) {
    console.error('Error in /v1/conversation', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`ha-bridge listening on port ${PORT}`);
});
