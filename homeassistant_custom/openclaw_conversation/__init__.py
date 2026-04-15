"""OpenClaw Conversation integration.

This integration exposes a conversation agent that forwards user utterances
from Home Assistant to the external `ha-bridge` service.

It's intentionally small: almost all logic lives in the bridge.
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN

PLATFORMS: list[str] = ["conversation"]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
  """Set up OpenClaw Conversation from a config entry."""
  hass.data.setdefault(DOMAIN, {})
  hass.data[DOMAIN][entry.entry_id] = entry.data

  await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
  return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
  """Unload a config entry."""
  unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
  if unload_ok and DOMAIN in hass.data:
      hass.data[DOMAIN].pop(entry.entry_id, None)
  return unload_ok
