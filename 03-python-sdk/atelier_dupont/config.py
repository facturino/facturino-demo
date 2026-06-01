"""Configuration and SDK client factory for the Atelier Dupont demo.

Everything the demo needs comes from the environment (see ``.env.example``
at the repo root). Nothing is hard-coded — copy that file to ``.env`` and
fill in your test-mode credentials before running.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

import facturino


def _strip_v1_suffix(base_url: str) -> str:
    """Normalize the base URL so the SDK's ``/v1/...`` paths resolve once.

    The SDK methods already prefix every path with ``/v1`` (e.g.
    ``/v1/account``), and its own default base URL is
    ``https://facturino.com/api``. The shared ``.env.example`` ships the
    human-facing form ``https://facturino.com/api/v1`` for clarity, so we
    drop a trailing ``/v1`` here to avoid emitting ``/api/v1/v1/account``.
    A trailing slash is also removed (the SDK does this too, but being
    explicit keeps the value predictable in logs).
    """
    url = base_url.rstrip("/")
    if url.endswith("/v1"):
        url = url[: -len("/v1")]
    return url


@dataclass(frozen=True)
class Settings:
    """Immutable runtime configuration, loaded once from the environment."""

    api_key: str
    base_url: str
    webhook_secret: str
    public_base_url: str
    port: int

    @property
    def is_test_mode(self) -> bool:
        """Whether the configured key targets the sandbox (``fac_test_``)."""
        return self.api_key.startswith("fac_test_")

    @property
    def webhook_url(self) -> str:
        """The publicly reachable URL Facturino will POST events to."""
        return f"{self.public_base_url.rstrip('/')}/webhooks"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Build the :class:`Settings` from the process environment.

    Raises:
        RuntimeError: if a required variable is missing, so the demo fails
            fast with an actionable message rather than a 401 mid-run.
    """
    api_key = os.environ.get("FACTURINO_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "FACTURINO_API_KEY is not set. Copy .env.example to .env and "
            "add your test-mode key (it starts with 'fac_test_')."
        )

    base_url = _strip_v1_suffix(
        os.environ.get("FACTURINO_BASE_URL", "https://facturino.com/api/v1").strip()
    )

    return Settings(
        api_key=api_key,
        base_url=base_url,
        webhook_secret=os.environ.get("FACTURINO_WEBHOOK_SECRET", "").strip(),
        public_base_url=os.environ.get(
            "PUBLIC_BASE_URL", "https://your-tunnel.example.com"
        ).strip(),
        port=int(os.environ.get("PORT", "4242")),
    )


@lru_cache(maxsize=1)
def get_client() -> facturino.Client:
    """Return a process-wide, reusable Facturino client.

    The client owns an HTTP connection pool, so we build it once and share
    it across requests (the same instance is safe for the demo's
    single-process Flask server).
    """
    settings = get_settings()
    return facturino.Client(settings.api_key, base_url=settings.base_url)
