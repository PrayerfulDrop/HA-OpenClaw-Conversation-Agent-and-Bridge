require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

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

const DEBUG_BRIDGE =
  process.env.DEBUG_BRIDGE === '1' || process.env.DEBUG_BRIDGE === 'true';

// In-memory per-session memory to help with lightweight multi-turn
// conversations (for example resolving pronouns like "it" back to the
// most recently mentioned entity) without round-tripping through HA chat
// sessions.
const lastTurnsBySession = new Map();

// Security profile settings for which domains/actions are allowed and which
// operations require an extra confirmation step. Loaded from
// config/ha_bridge_settings.json when present, with sane defaults.
const defaultSecuritySettings = {
  confirmations: {
    locks: { lock: false, unlock: true },
    covers: { close: false, open: true },
    alarm: { arm: false, disarm: true },
  },
};

let securitySettings = defaultSecuritySettings;
try {
  const configPath = path.join(__dirname, 'config', 'ha_bridge_settings.json');
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    securitySettings = {
      ...defaultSecuritySettings,
      ...parsed,
      confirmations: {
        ...defaultSecuritySettings.confirmations,
        ...(parsed.confirmations || {}),
      },
    };
    if (DEBUG_BRIDGE) {
      console.log('Loaded security settings from', configPath, securitySettings);
    }
  } else if (DEBUG_BRIDGE) {
    console.log('Security settings file not found, using defaults');
  }
} catch (err) {
  console.warn('Failed to load security settings, using defaults', err);
}

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
async function callBrain({ text, user, room, entities, conversationId, source, metadata, gatewayToken, sessionKey }) {
  const openclawBaseUrl = process.env.OPENCLAW_BASE_URL;
  const llmBaseUrl = openclawBaseUrl || process.env.LLM_BASE_URL;
  // Prefer a per-request gateway token when present; fall back to a static
  // API key for legacy setups that still talk directly to an LLM provider.
  const llmApiKey = gatewayToken || process.env.LLM_API_KEY;
  const llmModel = openclawBaseUrl
    ? 'openclaw/default'
    : process.env.LLM_MODEL || 'gpt-4.1-mini';
  const userContext = metadata?.openclaw?.user_context || '';

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

  const baseSystemPrompt = `You are the home automation brain for a smart home.
You receive user utterances plus structured context from Home Assistant
(user info, room, visible entities, metadata) as well as an optional
snapshot of Home Assistant entities and states (ha_snapshot).

Use ha_snapshot to answer questions about the current state of the home
(lights that are on, doors open, scenes, etc.). If ha_snapshot is missing
or does not contain the requested information, say so instead of
hallucinating.

The userPayload may include an "intent" field to hint what the user cares
about. For example:
- intent == "door_open_state" → focus on whether doors are physically
  open/closed using door/contact sensors.
- intent == "lock_state" → focus on whether locks are locked/unlocked
  using lock entities.

The userPayload may also include a "previous_turn" object with the last
user question and assistant reply for this user/device. Use it to resolve
pronouns like "it", "that", or "there" when the new question is
ambiguous. For example, if previous_turn.text mentioned the "Front Door"
and the new question is "Is it locked?", assume "it" refers to the Front
Door unless the user clearly asks about a different entity.

For doors, many setups have both a lock entity **and** a separate contact
or door sensor. When the user asks whether a door is open/closed, first
look for matching contact/door sensors (for example binary_sensor.* with a
door/entry device_class or a friendly_name that matches the lock/door name)
and answer based on those sensors. Only fall back to describing the lock
state when no relevant door/contact sensor is available.

When referring to entities in reply_text, always use the human-friendly
"friendly_name" (or a natural-language description), **never** raw Home
Assistant entity ids like "light.kitchen_main".

Keep reply_text concise and conversational. For simple state or yes/no
questions (for example, "Is the front door locked?"), answer in a single
short sentence ("Yes, the front door is locked" / "No, the front door is
unlocked") unless the user explicitly asks for more detail.

Only treat an entity as unavailable if its 'state' field is literally the
string "unavailable". A state of "off" means the entity is available but
currently off, and you can still send control actions to it.

Only include non-empty 'actions' when the user explicitly asks to change
something (turn on/off, open/close, start/stop, etc.). For pure questions,
leave 'actions' as an empty array.

For now, when creating 'ha_service' actions, you should restrict yourself
to safe domains like lights, switches, scenes, media players, fans,
climate, and **securing** actions for locks, covers, and the alarm panel.
Safe examples include "light.*", "switch.*", "scene.*",
"media_player.*", "fan.*", "climate.*", "lock.lock",
"cover.close_cover", "cover.close_cover_tilt",
"alarm_control_panel.alarm_arm_*".
Do NOT create unlock/open/disarm actions such as "lock.unlock",
"cover.open_cover*", or "alarm_control_panel.alarm_disarm". For those,
explain the security rules in reply_text and return no actions; the bridge
may handle confirmations separately.

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

  const systemPrompt = userContext
    ? `${baseSystemPrompt}\n\nUser-specific context (from Home Assistant configuration):\n${userContext}\n`
    : baseSystemPrompt;

  const haSnapshot = await fetchHaSnapshot();

  const previousTurn = sessionKey ? lastTurnsBySession.get(sessionKey) || null : null;

  // Very simple intent hinting to help the brain choose the right
  // information source (door/contact sensor vs lock) without hard-coding
  // full NLU rules.
  let intent = null;
  const lowerText = (text || '').toLowerCase();
  if (/\b(lock|locked|unlock|unlocked|secure)\b/.test(lowerText)) {
    intent = 'lock_state';
  } else if (/\b(open|closed|shut|ajar)\b/.test(lowerText)) {
    intent = 'door_open_state';
  }

  const userPayload = {
    text,
    intent,
    previous_turn: previousTurn,
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

  const sessionUser = conversationId || user?.id || 'home-assistant';

  const body = {
    model: llmModel,
    user: sessionUser,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
    temperature: 0.2,
  };

  try {
    if (DEBUG_BRIDGE) {
      console.log('callBrain ->', url, 'model=', llmModel);
    }
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

    let replyText =
      typeof parsed.reply_text === 'string'
        ? parsed.reply_text
        : `Sorry, I could not interpret that request.`;

    // Scrub any raw entity_ids out of the user-facing reply and prefer
    // friendly names when possible.
    replyText = scrubEntityIds(replyText, haSnapshot);

    if (sessionKey) {
      lastTurnsBySession.set(sessionKey, {
        text,
        intent,
        reply_text: replyText,
      });
    }

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
const MAX_HA_SNAPSHOT_CHARS = 120000; // soft cap to avoid LLM context overflow

/**
 * Replace raw Home Assistant entity_ids in reply text with friendly names
 * when possible, and strip any remaining ids as a last resort.
 */
function scrubEntityIds(replyText, haSnapshot) {
  if (!replyText || typeof replyText !== 'string') {
    return replyText;
  }

  let result = replyText;

  // Prefer explicit mappings from the HA snapshot when available.
  if (haSnapshot && Array.isArray(haSnapshot.entities)) {
    for (const entity of haSnapshot.entities) {
      const id = entity?.entity_id;
      const name = entity?.friendly_name;
      if (!id || !name) continue;

      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\\b${escaped}\\b`, 'g');
      result = result.replace(pattern, String(name));
    }
  }

  // As a safety net, strip any remaining domain.object_id-style tokens.
  result = result.replace(/\b[a-zA-Z_]+\.[a-zA-Z0-9_]+\b/g, 'that entity');

  return result;
}

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

    // Summarize entities to keep the payload small-ish.
    let entities = states.map((s) => {
      const entityId = s.entity_id || '';
      const [domain] = entityId.split('.');
      const attrs = s.attributes || {};
      return {
        entity_id: entityId,
        domain,
        friendly_name: attrs.friendly_name || null,
        area_id: attrs.area_id || null,
        room_name: attrs.room_name || null,
        device_class: attrs.device_class || null,
        state: s.state,
      };
    });

    // If the snapshot is too large for comfortable LLM context, trim it in a
    // structured way while keeping the most relevant domains.
    let snapshot = { entities };
    let approxSize = JSON.stringify(snapshot).length;
    if (approxSize > MAX_HA_SNAPSHOT_CHARS) {
      const priorityDomains = new Set([
        'lock',
        'cover',
        'alarm_control_panel',
        'binary_sensor',
        'climate',
        'fan',
        'media_player',
        'light',
        'switch',
        'scene',
        'script',
        'input_boolean',
      ]);

      entities = entities.filter((e) => priorityDomains.has(e.domain));
      snapshot = { entities };
      approxSize = JSON.stringify(snapshot).length;
    }

    if (approxSize > MAX_HA_SNAPSHOT_CHARS) {
      const allowedBinaryDeviceClasses = new Set([
        'door',
        'opening',
        'window',
        'garage_door',
        'lock',
      ]);

      entities = entities.filter((e) => {
        if (e.domain !== 'binary_sensor') return true;
        const dc = e.device_class;
        if (!dc) return false;
        return allowedBinaryDeviceClasses.has(dc);
      });
      snapshot = { entities };
      approxSize = JSON.stringify(snapshot).length;
    }

    if (approxSize > MAX_HA_SNAPSHOT_CHARS) {
      // Final safety: hard cap
      entities = entities.slice(0, 800);
      snapshot = { entities };
    }
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
    'lock',
    'cover',
    'alarm_control_panel',
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

    // Security profile: allow securing actions (lock/close/arm) but require
    // a separate confirmation flow for unsecuring actions (unlock/open/disarm).
    const confirmations = securitySettings.confirmations || {};

    if (domain === 'lock') {
      const lockConf = confirmations.locks || defaultSecuritySettings.confirmations.locks;
      const isLock = serviceName === 'lock';
      const isUnlock = serviceName === 'unlock';

      if (isUnlock) {
        if (lockConf.unlock) {
          errors.push({
            action,
            error: 'UNLOCK_REQUIRES_CONFIRMATION',
          });
          continue;
        }
      } else if (!isLock) {
        errors.push({
          action,
          error: 'LOCK_SERVICE_NOT_ALLOWED',
        });
        continue;
      }
    } else if (domain === 'cover') {
      const coverConf = confirmations.covers || defaultSecuritySettings.confirmations.covers;
      const isClose = serviceName === 'close_cover' || serviceName === 'close_cover_tilt';
      const isOpen = serviceName === 'open_cover' || serviceName === 'open_cover_tilt';

      if (isOpen) {
        if (coverConf.open) {
          errors.push({
            action,
            error: 'COVER_OPEN_REQUIRES_CONFIRMATION',
          });
          continue;
        }
      } else if (!isClose && serviceName !== 'stop_cover' && serviceName !== 'stop_cover_tilt') {
        errors.push({
          action,
          error: 'COVER_SERVICE_NOT_ALLOWED',
        });
        continue;
      }
    } else if (domain === 'alarm_control_panel') {
      const alarmConf = confirmations.alarm || defaultSecuritySettings.confirmations.alarm;
      const isArm = serviceName.startsWith('alarm_arm_');
      const isDisarm = serviceName === 'alarm_disarm';

      if (isDisarm) {
        if (alarmConf.disarm) {
          errors.push({
            action,
            error: 'ALARM_DISARM_REQUIRES_CONFIRMATION',
          });
          continue;
        }
      } else if (!isArm) {
        errors.push({
          action,
          error: 'ALARM_SERVICE_NOT_ALLOWED',
        });
        continue;
      }
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

  // Build a simple, stable-ish session key so we can keep a tiny amount of
  // per-user/device context inside the bridge (for example, the last
  // referenced entity) without relying on HA's conversation_id semantics.
  const sessionKey = `source:${source || 'unknown'}|user:${
    user?.id || 'anon'
  }|device:${room?.device_id || 'none'}|sat:${room?.satellite_id || 'none'}`;

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
      sessionKey,
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
