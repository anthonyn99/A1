"""Provider registry.

Every council member is built from config. To add an API-backed provider later,
register a factory here for its kind -- nothing in the engine, API layer, DB or
UI needs to change, because they all speak only the Provider interface.
"""

from __future__ import annotations

from ..settings import Settings
from .base import Provider
from .browser_base import BrowserProvider
from .gemini_api import GeminiAPIProvider, MissingKey

# API-backed providers, keyed by the id used to request one. These are NOT
# council members: build_providers() still returns only browser members, so
# quorum, window tiling and the chairman are unaffected. They are reachable
# through build_provider() by id, which is what the refiner uses.
API_PROVIDERS = {"gemini-api": GeminiAPIProvider}


def build_providers(settings: Settings, ids: list[str] | None = None) -> list[Provider]:
    """Instantiate enabled providers, in config order."""
    wanted = ids if ids is not None else settings.enabled_site_ids()
    out: list[Provider] = []
    for sid in wanted:
        if sid not in settings.sites:
            raise KeyError(
                f"Unknown provider {sid!r}. Known: {sorted(settings.sites)}. "
                f"Add it to config/selectors.yaml."
            )
        out.append(BrowserProvider(settings.site(sid), settings))
    return out


def build_provider(settings: Settings, provider_id: str) -> Provider:
    """Build one provider by id, browser-backed or API-backed.

    API ids are checked first and never reach settings.sites, which only knows
    about scraped sites. A missing key surfaces as ValueError so callers that
    already translate ValueError into a 400 keep working unchanged -- it is a
    configuration problem the user can fix, not a provider fault.
    """
    factory = API_PROVIDERS.get(provider_id)
    if factory is not None:
        try:
            return factory()
        except MissingKey as e:
            raise ValueError(str(e)) from e
    return build_providers(settings, [provider_id])[0]
