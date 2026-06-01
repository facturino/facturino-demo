"""Inbound webhook handling for the Atelier Dupont demo.

Facturino signs every webhook with an HMAC-SHA256 over ``{timestamp}.{body}``
and sends it in the ``Facturino-Signature`` header as ``t=<ts>,v1=<hex>``.
This demo uses the SDK's verification helper so the signature, the
anti-replay timestamp window and the constant-time comparison are all
handled correctly:

    event = facturino.Webhook.construct_event(raw_body, signature, secret)

The single most important rule: pass the **exact raw request bytes** to the
verifier — never a re-serialized JSON object, or the HMAC will not match.
"""

from __future__ import annotations

from typing import Any, Callable

from facturino import SignatureVerificationError, Webhook

# The header Facturino sets on every delivery.
SIGNATURE_HEADER = "Facturino-Signature"


def verify_and_parse(raw_body: bytes, signature_header: str, secret: str) -> dict[str, Any]:
    """Verify the signature and return the parsed event envelope.

    Args:
        raw_body: The exact bytes of the request body (do not parse first).
        signature_header: The value of the ``Facturino-Signature`` header.
        secret: The endpoint signing secret (``whsec_...``).

    Returns:
        The event dict: ``{ id, type, created, livemode, data: { object } }``.

    Raises:
        SignatureVerificationError: on a bad / missing signature or an event
            outside the replay-tolerance window.
    """
    return Webhook.construct_event(raw_body, signature_header, secret)


def handle_event(event: dict[str, Any]) -> dict[str, Any]:
    """Dispatch a verified event to its handler and return an ack payload.

    Webhook handlers must be fast and idempotent: a delivery can arrive more
    than once, so key any side effects on ``event["id"]``. Here we simply log
    the meaningful business transitions the SaaS cares about.
    """
    event_type = event.get("type", "")
    obj = event.get("data", {}).get("object", {})

    handler = _HANDLERS.get(event_type, _on_unhandled)
    summary = handler(obj, event)
    return {"received": True, "type": event_type, "summary": summary}


# --------------------------------------------------------------------------- #
# Per-event handlers — each returns a short human summary for the demo log.
# In a real SaaS these would update local state, notify staff, etc.
# --------------------------------------------------------------------------- #


def _on_invoice_finalized(obj: dict[str, Any], _event: dict[str, Any]) -> str:
    return f"Invoice {obj.get('number') or obj.get('id')} finalized — number assigned."


def _on_invoice_transmitted(obj: dict[str, Any], _event: dict[str, Any]) -> str:
    return f"Invoice {obj.get('number') or obj.get('id')} transmitted to the PA."


def _on_invoice_paid(obj: dict[str, Any], _event: dict[str, Any]) -> str:
    return f"Invoice {obj.get('number') or obj.get('id')} fully paid — provision the customer."


def _on_quote_accepted(obj: dict[str, Any], _event: dict[str, Any]) -> str:
    return f"Quote {obj.get('number') or obj.get('id')} accepted — convert to an invoice."


def _on_credit_note_finalized(obj: dict[str, Any], _event: dict[str, Any]) -> str:
    return f"Credit note {obj.get('number') or obj.get('id')} finalized."


def _on_unhandled(_obj: dict[str, Any], event: dict[str, Any]) -> str:
    return f"No specific handler for {event.get('type')!r}; acknowledged."


_HANDLERS: dict[str, Callable[[dict[str, Any], dict[str, Any]], str]] = {
    "invoice.finalized": _on_invoice_finalized,
    "invoice.transmitted": _on_invoice_transmitted,
    "invoice.paid": _on_invoice_paid,
    "quote.accepted": _on_quote_accepted,
    "credit_note.finalized": _on_credit_note_finalized,
}


__all__ = ["SIGNATURE_HEADER", "SignatureVerificationError", "verify_and_parse", "handle_event"]
