"""Config flow for OpenClaw Conversation."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    DOMAIN,
    CONF_BRIDGE_URL,
    CONF_API_KEY,
    CONF_EXTRA_CONTEXT,
    CONF_AGENT_MODEL,
    DEFAULT_EXTRA_CONTEXT,
    DEFAULT_AGENT_MODEL,
)


class OpenClawConversationConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for OpenClaw Conversation."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            bridge_url = user_input.get(CONF_BRIDGE_URL, "").strip()
            if not bridge_url:
                errors["base"] = "bridge_url_required"
            elif not (
                bridge_url.startswith("http://") or bridge_url.startswith("https://")
            ):
                errors["base"] = "bridge_url_invalid"

            if not errors:
                # We store bridge URL, optional Gateway token, optional
                # extra context, and optional agent model in the entry data.
                return self.async_create_entry(
                    title="OpenClaw Conversation",
                    data={
                        CONF_BRIDGE_URL: bridge_url,
                        CONF_API_KEY: (user_input.get(CONF_API_KEY) or "").strip(),
                        CONF_EXTRA_CONTEXT: (
                            user_input.get(CONF_EXTRA_CONTEXT)
                            or DEFAULT_EXTRA_CONTEXT
                        ).strip(),
                        CONF_AGENT_MODEL: (
                            user_input.get(CONF_AGENT_MODEL)
                            or DEFAULT_AGENT_MODEL
                        ).strip(),
                    },
                )

        data_schema = vol.Schema(
            {
                vol.Required(CONF_BRIDGE_URL): str,
                vol.Optional(CONF_API_KEY): str,
                vol.Optional(
                    CONF_AGENT_MODEL,
                    default=DEFAULT_AGENT_MODEL,
                ): str,
                vol.Optional(
                    CONF_EXTRA_CONTEXT,
                    default=DEFAULT_EXTRA_CONTEXT,
                ): selector.TextSelector(
                    selector.TextSelectorConfig(multiline=True)
                ),
            }
        )

        return self.async_show_form(
            step_id="user",
            data_schema=data_schema,
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: config_entries.ConfigEntry):
        """Return the options flow handler for this entry."""
        # Home Assistant will attach `config_entry` to the OptionsFlow
        # instance via the base class; we don't need to store it ourselves.
        return OpenClawConversationOptionsFlowHandler()


class OpenClawConversationOptionsFlowHandler(config_entries.OptionsFlow):
    """Handle options for an existing config entry."""
    async def async_step_init(self, user_input: dict[str, Any] | None = None):
        """Manage the options flow."""
        if user_input is not None:
            # Whatever the user enters here will end up in entry.options and
            # override entry.data when the entity is created.
            return self.async_create_entry(title="", data=user_input)

        current = {**self.config_entry.data, **self.config_entry.options}

        data_schema = vol.Schema(
            {
                vol.Required(
                    CONF_BRIDGE_URL,
                    default=current.get(CONF_BRIDGE_URL, ""),
                ): str,
                vol.Optional(
                    CONF_API_KEY,
                    default=current.get(CONF_API_KEY, ""),
                ): str,
                vol.Optional(
                    CONF_AGENT_MODEL,
                    default=current.get(CONF_AGENT_MODEL, DEFAULT_AGENT_MODEL),
                ): str,
                vol.Optional(
                    CONF_EXTRA_CONTEXT,
                    default=current.get(CONF_EXTRA_CONTEXT, DEFAULT_EXTRA_CONTEXT),
                ): selector.TextSelector(
                    selector.TextSelectorConfig(multiline=True)
                ),
            }
        )

        return self.async_show_form(step_id="init", data_schema=data_schema)
