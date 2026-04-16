"""OpenClaw Conversation agent entity.

This exposes a Home Assistant conversation agent that forwards messages to
an external HTTP bridge (`ha-bridge`).
"""

from __future__ import annotations

from typing import Any, Literal

from homeassistant.components import conversation
from homeassistant.components.conversation import (
    AssistantContent,
    ChatLog,
    ConversationEntity,
    ConversationEntityFeature,
    ConversationInput,
    ConversationResult,
)
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.config_entries import ConfigEntry

from .const import (
    DOMAIN,
    CONF_BRIDGE_URL,
    CONF_API_KEY,
    CONF_EXTRA_CONTEXT,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the OpenClaw conversation agent entity."""

    data = {**entry.data, **entry.options}
    bridge_url: str = data.get(CONF_BRIDGE_URL, "").rstrip("/")
    api_key: str | None = data.get(CONF_API_KEY) or None
    extra_context: str = data.get(CONF_EXTRA_CONTEXT, "") or ""

    if not bridge_url:
        # If misconfigured, we still add the entity, but it will error on use.
        bridge_url = ""

    async_add_entities([
        OpenClawConversationEntity(entry, bridge_url, api_key, extra_context)
    ])


class OpenClawConversationEntity(
    ConversationEntity,
    conversation.AbstractConversationAgent,
):
    """OpenClaw conversation agent."""

    _attr_supported_features = ConversationEntityFeature.CONTROL

    def __init__(
        self,
        entry: ConfigEntry,
        bridge_url: str,
        api_key: str | None = None,
        extra_context: str = "",
    ) -> None:
        super().__init__()
        self.entry = entry
        self._bridge_url = bridge_url
        self._api_key = api_key
        self._extra_context = extra_context

        # Make sure this shows up with a clear name in the HA UI
        self._attr_name = "OpenClaw Conversation"
        self._attr_unique_id = f"{entry.entry_id}_openclaw_conversation"

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        """Return a list of supported languages."""
        return MATCH_ALL

    async def async_added_to_hass(self) -> None:
        """When entity is added to Home Assistant."""
        await super().async_added_to_hass()
        conversation.async_set_agent(self.hass, self.entry, self)

    async def async_will_remove_from_hass(self) -> None:
        """When entity will be removed from Home Assistant."""
        await super().async_will_remove_from_hass()
        conversation.async_unset_agent(self.hass, self.entry)

    async def _async_handle_message(
        self,
        user_input: ConversationInput,
        chat_log: ChatLog,
    ) -> ConversationResult:
        """Forward the message to the bridge and return its response."""

        # Prepare payload for the bridge
        # Keep the top-level shape aligned with the bridge's expectations.
        payload: dict[str, Any] = {
            "text": user_input.text,
            "conversation_id": user_input.conversation_id,
            "user": {
                "id": user_input.context.user_id,
            },
            # Room/device context is best-effort; the bridge can enrich this
            # further using HA's APIs and exposure lists.
            "room": {
                "device_id": user_input.device_id,
                "satellite_id": user_input.satellite_id,
            },
            # We don't pass entities directly from HA here yet; the bridge can
            # look up exposed entities based on device_id / area, etc.
            "entities": [],
            "source": "home-assistant",
            "metadata": {
                "language": user_input.language,
                "context": user_input.context.as_dict(),
                "agent_id": user_input.agent_id,
                "openclaw": {
                    "user_context": self._extra_context,
                },
            },
        }

        # Call the bridge
        reply_text = "Sorry, something went wrong talking to the home brain."
        conversation_id = user_input.conversation_id

        if not self._bridge_url:
            reply_text = "OpenClaw conversation bridge URL is not configured."
        else:
            session = async_get_clientsession(self.hass)
            try:
                headers = {"Content-Type": "application/json"}
                if self._api_key:
                    headers["Authorization"] = f"Bearer {self._api_key}"

                async with session.post(
                    f"{self._bridge_url}/v1/conversation",
                    json=payload,
                    headers=headers,
                    timeout=30,
                ) as resp:
                    data = await resp.json()

                reply_text = (
                    data.get("reply_text")
                    or data.get("response")
                    or reply_text
                )
                conversation_id = (
                    data.get("conversation_id")
                    or user_input.conversation_id
                )

            except Exception as err:  # noqa: BLE001
                # We intentionally keep this simple and do not raise,
                # just return an error message to the user.
                reply_text = (
                    "Error talking to the OpenClaw bridge: " f"{err}"
                )

        # Add the assistant response to the chat log
        chat_log.async_add_assistant_content_without_tools(
            AssistantContent(
                agent_id=user_input.agent_id,
                content=reply_text,
            )
        )

        # Build an IntentResponse for Home Assistant
        response = intent.IntentResponse(language=user_input.language)
        response.async_set_speech(reply_text)

        return conversation.ConversationResult(
            conversation_id=conversation_id,
            response=response,
            continue_conversation=True,
        )
