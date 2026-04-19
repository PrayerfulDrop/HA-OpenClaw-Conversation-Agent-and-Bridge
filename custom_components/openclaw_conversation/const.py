DOMAIN = "openclaw_conversation"

CONF_BRIDGE_URL = "bridge_url"
# This field is shown in the HA UI as "API key" but is intended to carry the
# OpenClaw Gateway token in the recommended deployment.
CONF_API_KEY = "api_key"
CONF_EXTRA_CONTEXT = "extra_context"
CONF_AGENT_MODEL = "agent_model"

DEFAULT_AGENT_MODEL = "openclaw/default"

DEFAULT_EXTRA_CONTEXT = (
    "You are a concise home status assistant for my house. "
    "Keep replies to one short sentence when possible, use human-friendly "
    "device names, never mention Home Assistant entity_ids, and prefer "
    "door/contact sensors when answering door open/closed questions."
)
