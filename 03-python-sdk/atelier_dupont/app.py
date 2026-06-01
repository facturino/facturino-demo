"""Flask server for the Atelier Dupont demo (Facturino python-sdk).

Routes
------
GET  /                 Health + index of available routes.
POST /run              Run the full A->J scenario; returns a structured report.
POST /run/<phase>      Run a single phase (a..j); bootstraps prerequisites.
POST /webhooks         Receive Facturino events: verify the signature, dispatch.

Run it with::

    python -m atelier_dupont.app
    # or:  flask --app atelier_dupont.app run --port "$PORT"
"""

from __future__ import annotations

from typing import Any

from flask import Flask, jsonify, request

from facturino import ApiError, FacturinoError

from .config import get_client, get_settings
from .helpers import describe_error
from .scenario import PHASES, run_all, run_phase
from .webhooks import SIGNATURE_HEADER, SignatureVerificationError, handle_event, verify_and_parse


def create_app() -> Flask:
    """Application factory — keeps the demo importable and testable."""
    app = Flask(__name__)

    @app.get("/")
    def index() -> Any:
        settings = get_settings()
        return jsonify(
            {
                "service": "atelier-dupont demo (facturino python-sdk)",
                "livemode": not settings.is_test_mode,
                "base_url": settings.base_url,
                "webhook_url": settings.webhook_url,
                "routes": {
                    "POST /run": "Run the full A->J scenario",
                    "POST /run/<phase>": f"Run one phase ({'/'.join(PHASES)})",
                    "POST /webhooks": "Receive signed Facturino events",
                },
                "phases": PHASES,
            }
        )

    @app.post("/run")
    def run() -> Any:
        settings = get_settings()
        try:
            report = run_all(get_client(), webhook_url=settings.webhook_url)
        except ApiError as exc:
            # A fatal API error mid-journey: surface it with its request_id.
            return jsonify(describe_error(exc)), exc.status_code or 500
        except FacturinoError as exc:
            return jsonify({"error": {"type": "sdk_error", "message": str(exc)}}), 502
        return jsonify(report), 200 if report["ok"] else 207

    @app.post("/run/<phase>")
    def run_one(phase: str) -> Any:
        settings = get_settings()
        try:
            report = run_phase(get_client(), phase, webhook_url=settings.webhook_url)
        except ValueError as exc:
            return jsonify({"error": {"type": "invalid_request_error", "message": str(exc)}}), 400
        except ApiError as exc:
            return jsonify(describe_error(exc)), exc.status_code or 500
        except FacturinoError as exc:
            return jsonify({"error": {"type": "sdk_error", "message": str(exc)}}), 502
        return jsonify(report), 200 if report["ok"] else 207

    @app.post("/webhooks")
    def webhooks() -> Any:
        settings = get_settings()
        if not settings.webhook_secret:
            # Fail closed: never accept unverified events.
            return jsonify({"error": {"message": "FACTURINO_WEBHOOK_SECRET is not configured"}}), 503

        # IMPORTANT: read the *raw* bytes before any parsing — the signature
        # is computed over the exact body, so re-serializing would break it.
        raw_body = request.get_data()
        signature = request.headers.get(SIGNATURE_HEADER, "")

        try:
            event = verify_and_parse(raw_body, signature, settings.webhook_secret)
        except SignatureVerificationError as exc:
            # 400 tells Facturino the delivery was rejected (it will retry).
            return jsonify({"error": {"type": "signature_verification", "message": str(exc)}}), 400

        result = handle_event(event)
        # Acknowledge quickly with 2xx so Facturino marks the delivery done.
        return jsonify(result), 200

    return app


# Module-level WSGI app for `flask --app atelier_dupont.app`.
app = create_app()


def main() -> None:
    """Entry point for ``python -m atelier_dupont.app``."""
    settings = get_settings()
    # threaded=True so a /run call (which makes many blocking API requests)
    # does not block an incoming /webhooks delivery on the same process.
    app.run(host="0.0.0.0", port=settings.port, threaded=True)


if __name__ == "__main__":
    main()
