require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const app = express();
// Allow slightly larger JSON bodies from Home Assistant while still keeping
// a sane upper bound. Default is ~100kb; we bump to 512kb to tolerate rich
// metadata without risking unbounded growth.
app.use(express.json({ limit: '512kb' }));

const PORT = process.env.PORT || 8080;

// Optional configuration for later wiring
const OPENCLAW_BASE_URL = process.env.OPENCLAW_BASE_URL || null;
const HA_BASE_URL = process.env.HOME_ASSISTANT_BASE_URL || null;
const HA_TOKEN = process.env.HOME_ASSISTANT_TOKEN || null;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || null;

// Optional UniFi controller config for richer read-only observability
// (for example, answering "how many Wi-Fi devices are on my network?").
//
// These are intentionally environment variables so secrets stay out of
// the repo and can be injected via Docker or systemd:
// - UNIFI_BASE_URL (e.g. "https://192.168.4.1")
// - UNIFI_USERNAME
// - UNIFI_PASSWORD
// - UNIFI_SITE (optional, default "default")
const UNIFI_BASE_URL = process.env.UNIFI_BASE_URL || null;
const UNIFI_USERNAME = process.env.UNIFI_USERNAME || null;
const UNIFI_PASSWORD = process.env.UNIFI_PASSWORD || null;
const UNIFI_SITE = process.env.UNIFI_SITE || 'default';

// Optional SSH target for the Plex host. This is now only used by
// legacy helper code; new investigative behavior should come from
// config-driven tools (see README). It remains here for backwards
// compatibility and can be removed in a future major version.
// NOTE: The compiled container currently has this defined twice; the
// source of truth for future builds is this single definition.
const PLEX_SSH = process.env.PLEX_SSH || 'wardfamily1909@192.168.6.196';

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

// Pending security-sensitive actions (unlock/open/disarm) that require an
// explicit follow-up confirmation before execution.
const pendingSecurityBySession = new Map();

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

async function runSshCommand(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile('ssh', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr && String(stderr).trim() ? stderr : err.message;
        if (DEBUG_BRIDGE) {
          console.error('SSH command failed', args.join(' '), msg);
        }
        return reject(new Error(msg));
      }
      resolve(stdout || '');
    });
  });
}

async function fetchServerCronSnapshot({ ssh, name, role }) {
  try {
    const stdout = await runSshCommand(
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        ssh,
        'set -e; echo "---CRONTAB_ROOT---"; sudo crontab -l 2>/dev/null || echo "NO_CRONTAB_ROOT"; echo "---CRONTAB_USER---"; crontab -l 2>/dev/null || echo "NO_CRONTAB_USER";',
      ],
      10000,
    );

    const rootMarker = '---CRONTAB_ROOT---';
    const userMarker = '---CRONTAB_USER---';

    const rootIdx = stdout.indexOf(rootMarker);
    const userIdx = stdout.indexOf(userMarker);

    let rootBlock = '';
    let userBlock = '';

    if (rootIdx >= 0 && userIdx > rootIdx) {
      rootBlock = stdout.slice(rootIdx + rootMarker.length, userIdx);
      userBlock = stdout.slice(userIdx + userMarker.length);
    }

    const parseCron = (block) =>
      block
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !/^NO_CRONTAB_/.test(l));

    const rootCron = parseCron(rootBlock);
    const userCron = parseCron(userBlock);

    return {
      host: name,
      role,
      cron: {
        root: rootCron,
        user: userCron,
      },
      last_checked: new Date().toISOString(),
    };
  } catch (err) {
    if (DEBUG_BRIDGE) {
      console.error('Failed to fetch cron snapshot for', ssh, err.message || err);
    }
    return null;
  }
}

async function fetchUnifiClientSnapshot() {
  if (!UNIFI_BASE_URL || !UNIFI_USERNAME || !UNIFI_PASSWORD) {
    return null;
  }

  try {
    const base = UNIFI_BASE_URL.replace(/\/$/, '');

    // Use curl with -k to tolerate the controller's self-signed cert. This
    // mirrors the manual curl flow we validated from the host.
    const loginPayload = JSON.stringify({
      username: UNIFI_USERNAME,
      password: UNIFI_PASSWORD,
      rememberMe: true,
    });

    await new Promise((resolve, reject) => {
      execFile(
        'curl',
        [
          '-sSk',
          '-c',
          '/tmp/unifi-cookie.txt',
          '-X',
          'POST',
          `${base}/api/auth/login`,
          '-H',
          'Content-Type: application/json',
          '--data',
          loginPayload,
        ],
        { timeout: 15000 },
        (err, stdout, stderr) => {
          if (err) {
            if (DEBUG_BRIDGE) {
              console.error('UniFi login curl failed', err.message || err, stderr || '');
            }
            return reject(err);
          }
          resolve(stdout || '');
        },
      );
    });

    const clientsJson = await new Promise((resolve, reject) => {
      execFile(
        'curl',
        [
          '-sSk',
          '-b',
          '/tmp/unifi-cookie.txt',
          `${base}/proxy/network/api/s/${encodeURIComponent(UNIFI_SITE)}/stat/sta`,
        ],
        { timeout: 15000 },
        (err, stdout, stderr) => {
          if (err) {
            if (DEBUG_BRIDGE) {
              console.error('UniFi clients curl failed', err.message || err, stderr || '');
            }
            return reject(err);
          }
          resolve(stdout || '');
        },
      );
    });

    const json = JSON.parse(clientsJson);
    const data = Array.isArray(json?.data) ? json.data : [];

    const wifiClients = data.filter((c) => !c.is_wired);

    return {
      controller_url: UNIFI_BASE_URL,
      site: UNIFI_SITE,
      wifi_client_count: wifiClients.length,
      total_client_count: data.length,
      last_checked: new Date().toISOString(),
    };
  } catch (err) {
    if (DEBUG_BRIDGE) {
      console.error('Error fetching UniFi client snapshot', err?.message || err);
    }
    return null;
  }
}

async function fetchHostSnapshot() {
  // This function used to contain hard-coded SSH logic for specific hosts
  // (for example a particular Plex server or llm-home instance). To keep
  // this bridge generic and portable, that per-host logic has been
  // removed in favor of config-driven, OpenClaw-tool-based inspection.
  //
  // The investigative HA agent (for example `openclaw/ha-bridge`) is
  // expected to:
  //   - Discover host configuration from files in the OpenClaw workspace
  //     such as `config/ha_servers.json` or TOOLS.md.
  //   - Use generic, read-only helpers (for example
  //     `scripts/ha_server_inspect.sh`) via OpenClaw's exec/SSH tools to
  //     answer questions like "what cron jobs are running on X?".
  //
  // For backward compatibility, we still expose UniFi Wi-Fi client counts
  // here when configured. All other host-level observability should come
  // from tools, not from hard-coded Node helpers.

  const snapshot = {};

  // UniFi Wi-Fi / network client snapshot (read-only)
  try {
    const unifi = await fetchUnifiClientSnapshot();
    if (unifi) {
      snapshot.unifi = unifi;
    }
  } catch (err) {
    if (DEBUG_BRIDGE) {
      console.error('Failed to build host_snapshot for UniFi', err.message || err);
    }
  }

  return snapshot;
}

// Basic health check
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

// Optional debug endpoint to inspect the current host_snapshot that would
// be passed to the brain. Useful while wiring up external controllers
// like UniFi.
app.get('/debug/host', async (_req, res) => {
  try {
    const snapshot = await fetchHostSnapshot();
    res.json(snapshot || {});
  } catch (err) {
    console.error('Error in /debug/host', err);
    res.status(500).json({ error: 'failed to build host_snapshot' });
  }
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
async function callBrain({
  text,
  user,
  room,
  entities,
  conversationId,
  source,
  metadata,
  gatewayToken,
  sessionKey,
  // mode === 'control' → normal HA brain (may propose safe actions)
  // mode === 'info'    → read-only informational brain (no actions)
  mode = 'control',
}) {
  const openclawBaseUrl = process.env.OPENCLAW_BASE_URL;
  const llmBaseUrl = openclawBaseUrl || process.env.LLM_BASE_URL;
  // Prefer a per-request gateway token when present; fall back to a static
  // API key for legacy setups that still talk directly to an LLM provider.
  const llmApiKey = gatewayToken || process.env.LLM_API_KEY;
  const userContext = metadata?.openclaw?.user_context || '';
  const agentModelOverride = metadata?.openclaw?.agent_model || null;

  // When talking to an OpenClaw Gateway, prefer a dedicated HA
  // investigative agent model if configured. Precedence:
  //   1) metadata.openclaw.agent_model (per-request override from HA)
  //   2) OPENCLAW_AGENT_MODEL environment variable (recommended)
  //   3) openclaw/default fallback
  const openclawAgentModel = process.env.OPENCLAW_AGENT_MODEL || null;

  const llmModel = openclawBaseUrl
    ? agentModelOverride || openclawAgentModel || 'openclaw/default'
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

  const baseSystemPrompt = `You are the home automation brain for a smart home.
You receive user utterances plus structured context from Home Assistant
(user info, room, visible entities, metadata) as well as an optional
snapshot of Home Assistant entities and states (ha_snapshot).

Use ha_snapshot to answer questions about the current state of the home
(lights that are on, doors open, scenes, etc.). If ha_snapshot is missing
or does not contain the requested information, say so instead of
hallucinating.

You may also receive a host_snapshot object that contains read-only
diagnostic information about important non-HA hosts (servers, routers,
UniFi controllers, media servers, etc.). When the user asks about
something outside of HA that host_snapshot covers (for example, how many
Wi‑Fi clients are online), prefer to answer using host_snapshot instead
of telling the user to check manually. Only say you cannot see that
information when it is truly absent from host_snapshot and from any
other tools available to you.

In addition to Home Assistant, you may also have access to other
OpenClaw tools and context (for example host health checks, SSH access
to servers, UniFi controller APIs, or other services). For this Home
Assistant pathway, treat all such operations as **read-only**: you may
run diagnostics and queries to gather information, but you must not apply
updates, restart services, change configuration, or otherwise modify
external systems. When the user asks about things outside of HA (such as
OS patch status on a server or the number of UniFi clients), prefer
using whatever tools OpenClaw exposes to you to answer accurately instead
of guessing from ha_snapshot alone.

For non-HA questions about specific servers (for example, "Are there any
issues with Docker on llm-home?"), follow this pattern:
- First, treat the question as **investigative/read-only** by default and
  look for a config-driven host registry in the OpenClaw workspace to
  resolve host labels to SSH targets.
- If a matching host is configured, use only read-only diagnostics (for
  example, running workspace helpers like a generic server-inspect script
  via exec/SSH) to gather information and summarize it back to the user
  in a concise way.
- If the required config-driven task or host entry does not yet exist,
  explicitly say that you do not know how to do this yet and ask the
  user whether they want to wire it up. In that case, provide clear,
  safe instructions (for example, which helper script to run on the
  OpenClaw host to add the server), instead of attempting to change
  SSH keys or config yourself.
- If fulfilling the request would require performing **state-changing
  actions** on non-HA systems (for example, restarting Docker, applying
  updates, modifying configuration), you MUST refuse to create or
  execute such a task and respond with exactly this sentence and
  nothing else:

  "I am sorry but there are limitations to what I am allowed to do. Any
  actions like what you asked is not permitted for security reasons."

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
Unlock/open/disarm actions such as "lock.unlock", "cover.open_cover*",
or "alarm_control_panel.alarm_disarm" are **allowed but must be
confirmation-gated**. When the user asks to unlock, open, or disarm,
include the appropriate action in the actions array, and make
reply_text a clear confirmation question (for example, "Just to confirm,
do you want me to unlock the Front Door now?"). The bridge will only
execute those actions after an explicit follow-up confirmation from the
user.

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

  // Adjust behavior for read-only informational mode. In this mode the
  // brain must **never** propose actions; it is an observability-only
  // channel.
  let systemPrompt = baseSystemPrompt;

  if (mode === 'info') {
    systemPrompt += `\n\nIMPORTANT: You are currently operating in a READ-ONLY, information-only mode.\n- You must NEVER propose or return any actions in the \\"actions\\" array.\n- Always return \\"actions\\": [] in your JSON response, even if the user asks to\n  turn things on/off, open/close, lock/unlock, arm/disarm, update, restart,\n  or otherwise change anything.\n- You may freely use any available tools, snapshots, or diagnostics to READ\n  state and explain it, but you must not plan or request changes.\n- When the user asks you to change something, clearly explain that this\n  pathway is informational-only and cannot perform actions, then answer with\n  whatever relevant READ-ONLY information you can provide.`;
  }

  if (userContext) {
    systemPrompt += `\n\nUser-specific context (from Home Assistant configuration):\n${userContext}\n`;
  }

  const haSnapshot = await fetchHaSnapshot();
  const hostSnapshot = await fetchHostSnapshot();

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
    host_snapshot: hostSnapshot,
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
      // If the model didn't follow the JSON contract, fall back to treating
      // the plain content as the reply text with no actions instead of
      // surfacing a stub error. This is safer and preserves useful answers
      // from the brain even when it ignores the JSON schema.
      console.error('Failed to parse LLM JSON content', err, content);

      let fallbackReplyText = scrubEntityIds(content, haSnapshot);

      if (sessionKey) {
        lastTurnsBySession.set(sessionKey, {
          text,
          intent,
          reply_text: fallbackReplyText,
        });
      }

      return {
        replyText: fallbackReplyText,
        actions: [],
        conversationId: conversationId || null,
        llm_used: true,
      };
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

    // If this looks like a non-HA state-changing request (for example,
    // "reboot plex" or "shutdown the plex server"), we deliberately do
    // NOT surface a connectivity-style error. Instead we return the
    // explicit safety message that the user expects from this HA
    // pathway.
    const looksLikeNonHaStateChange = (() => {
      if (!lowerText) return false;
      const verbs = /(reboot|restart|shutdown|shut down|power off|poweroff|update|upgrade|apply updates?)/;
      const hosts = /(plex|llm-home|wardnas|ward-nas|nas|unifi|router)/;
      return verbs.test(lowerText) && hosts.test(lowerText);
    })();

    let fallbackReply;
    if (openclawBaseUrl && looksLikeNonHaStateChange) {
      fallbackReply =
        'I am sorry but there are limitations to what I am allowed to do. Any actions like what you asked is not permitted for security reasons.';
    } else if (openclawBaseUrl) {
      fallbackReply =
        'I could not reach the OpenClaw brain just now. ' +
        'Please check that the OpenClaw Conversation Agent in Home Assistant has the correct Bridge URL and Gateway token, ' +
        "and that the Gateway's /v1/chat/completions HTTP endpoint is enabled. ";
    } else {
      fallbackReply = replyText;
    }

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
// Aggressive soft cap to keep requests under the Gateway/LLM payload limit.
// We prefer to send a smaller, focused snapshot rather than hitting HTTP 413.
const MAX_HA_SNAPSHOT_CHARS = 40000;

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
 * Split actions into those that can be executed immediately and those that
 * require an explicit confirmation step based on the security profile.
 */
function splitActionsBySecurityProfile(actions) {
  const toExecute = [];
  const toConfirm = [];

  if (!Array.isArray(actions)) {
    return { toExecute, toConfirm };
  }

  const confirmations = securitySettings.confirmations || defaultSecuritySettings.confirmations;

  for (const action of actions) {
    if (!action || action.type !== 'ha_service') {
      toExecute.push(action);
      continue;
    }

    const { service } = action;
    if (!service || typeof service !== 'string' || !service.includes('.')) {
      toExecute.push(action);
      continue;
    }

    const [domain, serviceName] = service.split('.');

    if (domain === 'lock') {
      const lockConf = confirmations.locks || defaultSecuritySettings.confirmations.locks;
      const isUnlock = serviceName === 'unlock';
      if (isUnlock && lockConf.unlock) {
        toConfirm.push(action);
        continue;
      }
      toExecute.push(action);
      continue;
    }

    if (domain === 'cover') {
      const coverConf = confirmations.covers || defaultSecuritySettings.confirmations.covers;
      const isOpen = serviceName === 'open_cover' || serviceName === 'open_cover_tilt';
      if (isOpen && coverConf.open) {
        toConfirm.push(action);
        continue;
      }
      toExecute.push(action);
      continue;
    }

    if (domain === 'alarm_control_panel') {
      const alarmConf = confirmations.alarm || defaultSecuritySettings.confirmations.alarm;
      const isDisarm = serviceName === 'alarm_disarm';
      if (isDisarm && alarmConf.disarm) {
        toConfirm.push(action);
        continue;
      }
      toExecute.push(action);
      continue;
    }

    // All other domains: execute immediately.
    toExecute.push(action);
  }

  return { toExecute, toConfirm };
}

function getFriendlyNameFromSnapshot(entityId, haSnapshot) {
  if (!entityId || !haSnapshot || !Array.isArray(haSnapshot.entities)) {
    return null;
  }
  const match = haSnapshot.entities.find((e) => e.entity_id === entityId);
  return match?.friendly_name || null;
}

function buildConfirmationReply(pending, haSnapshot) {
  if (!pending || !Array.isArray(pending.actions) || pending.actions.length === 0) {
    return null;
  }

  const action = pending.actions[0];
  if (!action || action.type !== 'ha_service') {
    return null;
  }

  const { service, entity_id, target } = action;
  if (!service || typeof service !== 'string' || !service.includes('.')) {
    return null;
  }

  const [domain, serviceName] = service.split('.');

  const ids = [];
  if (entity_id) {
    if (Array.isArray(entity_id)) ids.push(...entity_id);
    else ids.push(entity_id);
  }
  if (target && target.entity_id) {
    if (Array.isArray(target.entity_id)) ids.push(...target.entity_id);
    else ids.push(target.entity_id);
  }

  const uniqueIds = Array.from(new Set(ids));
  const names = uniqueIds
    .map((id) => getFriendlyNameFromSnapshot(id, haSnapshot) || id)
    .filter(Boolean);

  const friendlyList =
    names.length === 1
      ? names[0]
      : names.length > 1
      ? names.join(', ')
      : 'requested entity';

  if (domain === 'lock') {
    if (serviceName === 'unlock') {
      return `The ${friendlyList} has been unlocked.`;
    }
    if (serviceName === 'lock') {
      return `The ${friendlyList} has been locked.`;
    }
  }

  if (domain === 'cover') {
    if (serviceName === 'open_cover' || serviceName === 'open_cover_tilt') {
      return `The ${friendlyList} has been opened.`;
    }
    if (
      serviceName === 'close_cover' ||
      serviceName === 'close_cover_tilt' ||
      serviceName === 'stop_cover' ||
      serviceName === 'stop_cover_tilt'
    ) {
      return `The ${friendlyList} has been closed.`;
    }
  }

  if (domain === 'alarm_control_panel') {
    if (serviceName === 'alarm_disarm') {
      return 'The alarm has been disarmed.';
    }
    if (serviceName.startsWith('alarm_arm_')) {
      return 'The alarm has been armed.';
    }
  }

  return null;
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

  // Heuristic routing: decide whether this looks like a pure information
  // query (read-only) or a control-style request. This lets a single
  // Home Assistant Conversation agent support both general control and
  // "observability Brian" questions over voice.
  const inferInfoOnly = (rawText) => {
    if (!rawText || typeof rawText !== 'string') return false;
    const t = rawText.trim().toLowerCase();
    if (!t) return false;

    const isQuestion =
      t.endsWith('?') ||
      /^(what|where|when|who|whom|whose|why|how|is|are|do|does|did|can|could|should|would|will|am)\b/.test(
        t,
      );

    const looksLikeImperative =
      /^(turn|set|lock|unlock|open|close|arm|disarm|start|stop|run|update|install|restart|reboot|shutdown|power off|enable|disable)\b/.test(
        t,
      ) ||
      /\bturn (on|off)\b/.test(t);

    // Treat as info-only when it clearly looks like a question and not an
    // imperative command. This allows queries like
    // "is the plex server up to date with updates?" to be read-only even
    // though they mention "updates".
    return isQuestion && !looksLikeImperative;
  };

  try {
    // First, check if this looks like a confirmation for a pending
    // security-sensitive action (unlock/open/disarm).
    const pending = pendingSecurityBySession.get(sessionKey) || null;
    const normalizedText = (text || '').trim().toLowerCase();
    const isConfirmation =
      pending &&
      normalizedText &&
      /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|please do|confirm)\b/.test(
        normalizedText,
      );

    if (pending && isConfirmation) {
      pendingSecurityBySession.delete(sessionKey);

      const { executed, errors } = await executeActions(pending.actions || []);

      const haSnapshot = await fetchHaSnapshot();
      const replyText =
        buildConfirmationReply(pending, haSnapshot) ||
        pending.confirmation_reply ||
        'Okay, I have applied your previous request.';

      const response = {
        reply_text: replyText,
        conversation_id: pending.conversationId || conversationId || null,
        actions: pending.actions || [],
        executed_actions: executed,
        action_errors: errors,
        debug: {
          source: source || 'unknown',
          received_entities: entities || [],
          metadata: metadata || {},
          openclaw_base_url: OPENCLAW_BASE_URL,
          ha_configured: Boolean(HA_BASE_URL && HA_TOKEN),
          execute_ha_actions: EXECUTE_HA_ACTIONS,
          auth_required: Boolean(BRIDGE_API_KEY),
          pending_security_confirmed: true,
        },
      };

      return res.json(response);
    }

    // If there was a pending action but the user said something else,
    // clear it so we don't accidentally apply it later.
    if (pending && !isConfirmation) {
      pendingSecurityBySession.delete(sessionKey);
    }

    const infoOnly = inferInfoOnly(text);

    if (infoOnly) {
      // Read-only informational path: ask the brain in info mode and never
      // execute or even expose actions.
      const brainResult = await callBrain({
        text,
        user,
        room,
        entities,
        conversationId,
        source,
        metadata: {
          ...(metadata || {}),
          mode: 'info_only',
        },
        gatewayToken,
        sessionKey,
        mode: 'info',
      });

      const response = {
        reply_text: brainResult.replyText,
        conversation_id: brainResult.conversationId,
        actions: [],
        executed_actions: [],
        action_errors: [],
        debug: {
          source: source || 'unknown',
          received_entities: entities || [],
          metadata: metadata || {},
          openclaw_base_url: OPENCLAW_BASE_URL,
          ha_configured: Boolean(HA_BASE_URL && HA_TOKEN),
          execute_ha_actions: false,
          auth_required: Boolean(BRIDGE_API_KEY),
          routed_as: 'info',
        },
      };

      return res.json(response);
    }

    // Step 1: ask the brain what to do in normal control mode.
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
      mode: 'control',
    });

    // Split actions into those that can run immediately and those that
    // require an explicit confirmation step based on the security profile.
    const { toExecute, toConfirm } = splitActionsBySecurityProfile(
      brainResult.actions,
    );

    if (toConfirm.length > 0) {
      pendingSecurityBySession.set(sessionKey, {
        actions: toConfirm,
        createdAt: Date.now(),
        original_text: text,
        reply_text: brainResult.replyText,
        conversationId: brainResult.conversationId || conversationId || null,
      });
    }

    // Step 2: if there are actions that are safe to run immediately, try to
    // execute them against HA.
    const { executed, errors } = await executeActions(toExecute);

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
        routed_as: 'control',
      },
    };

    res.json(response);
  } catch (err) {
    console.error('Error in /v1/conversation', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Read-only informational endpoint.
 *
 * This endpoint is designed for "observability Brian": it allows any
 * question about things OpenClaw can see (HA state, host snapshots,
 * external tools) but **never** executes actions or proposes changes.
 *
 * - Uses the same brain + snapshots as /v1/conversation
 * - Calls callBrain(mode: 'info') so the system prompt enforces actions: []
 * - Ignores any actions the model might still try to return
 */
app.post('/v1/info', async (req, res) => {
  const {
    text,
    conversation_id: conversationId,
    user,
    room,
    entities,
    source,
    metadata,
  } = req.body || {};

  const authHeader = req.headers['authorization'] || '';
  let gatewayToken = null;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    gatewayToken = authHeader.slice(7).trim();
  }

  if (!OPENCLAW_BASE_URL && BRIDGE_API_KEY) {
    if (!gatewayToken || gatewayToken !== BRIDGE_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing required field: text' });
  }

  // We still build a session key so the brain can use previous_turn
  // context, but we do NOT support pending action confirmations here,
  // because this endpoint is strictly read-only.
  const sessionKey = `info|source:${source || 'unknown'}|user:${
    user?.id || 'anon'
  }|device:${room?.device_id || 'none'}|sat:${room?.satellite_id || 'none'}`;

  try {
    const brainResult = await callBrain({
      text,
      user,
      room,
      entities,
      conversationId,
      source,
      // Hint to the brain that this is an info-only path.
      metadata: {
        ...(metadata || {}),
        mode: 'info_only',
      },
      gatewayToken,
      sessionKey,
      mode: 'info',
    });

    const response = {
      reply_text: brainResult.replyText,
      conversation_id: brainResult.conversationId || conversationId || null,
      // Enforce read-only contract at the bridge layer as well.
      actions: [],
      executed_actions: [],
      action_errors: [],
      debug: {
        source: source || 'unknown',
        received_entities: entities || [],
        metadata: metadata || {},
        openclaw_base_url: OPENCLAW_BASE_URL,
        ha_configured: Boolean(HA_BASE_URL && HA_TOKEN),
        execute_ha_actions: false,
        auth_required: Boolean(BRIDGE_API_KEY),
        mode: 'info',
      },
    };

    res.json(response);
  } catch (err) {
    console.error('Error in /v1/info', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`ha-bridge listening on port ${PORT}`);
});
