"""Shared helpers: idempotency keys, error formatting, job polling, logging.

These utilities keep the scenario module readable and demonstrate the
patterns every production integration should adopt:

- a **stable** idempotency key per logical step, so retries never create
  duplicates;
- surfacing ``request_id`` on every API error (it is what support asks for);
- polling async jobs (PDF / Factur-X / FEC generation) to completion.
"""

from __future__ import annotations

import hashlib
import time
from typing import Any, Callable, Optional

import facturino
from facturino import ApiError

# Namespace for deterministic idempotency keys. Bump the run id (or pass a
# different one) to force a genuinely new set of resources.
_RUN_NAMESPACE = "atelier-dupont-demo"


def idempotency_key(step: str, run_id: str = "default") -> str:
    """Return a stable, collision-resistant Idempotency-Key for a step.

    The same ``(step, run_id)`` pair always yields the same key, so a retried
    POST is recognized by the API as a replay and returns the original
    resource instead of creating a second one.

    Args:
        step: A short, unique label for the creation step (e.g.
            ``"create-customer"``).
        run_id: Logical run identifier; change it to start a fresh,
            non-colliding scenario run.
    """
    digest = hashlib.sha256(f"{_RUN_NAMESPACE}:{run_id}:{step}".encode()).hexdigest()
    return f"idem_{digest[:32]}"


def describe_error(exc: ApiError) -> dict[str, Any]:
    """Turn an :class:`ApiError` into a JSON-safe dict for the HTTP response.

    Always includes ``request_id`` — quote it verbatim when contacting
    Facturino support so they can trace the exact request.
    """
    return {
        "error": {
            "type": exc.type,
            "code": exc.code,
            "message": exc.message,
            "param": exc.param,
            "status_code": exc.status_code,
            "request_id": exc.request_id,
            "doc_url": exc.doc_url,
            "hint": exc.hint,
        }
    }


def poll_job(
    client: facturino.Client,
    job_id: str,
    *,
    interval: float = 1.0,
    timeout: float = 60.0,
) -> dict[str, Any]:
    """Poll an async job until it is ``completed`` or ``failed``.

    Several endpoints (PDF, Factur-X, FEC, CSV import/export, audit-trail
    PDF) return ``202 Accepted`` with a ``jobId`` and run the heavy work in
    the background. This helper resolves that job to a terminal state.

    Args:
        client: The Facturino SDK client.
        job_id: The ``job_...`` identifier returned by the 202 response.
        interval: Seconds between polls.
        timeout: Maximum seconds to wait before giving up.

    Returns:
        The terminal job dict (``status`` is ``completed`` or ``failed``).

    Raises:
        TimeoutError: if the job is still running after ``timeout`` seconds.
    """
    deadline = time.monotonic() + timeout
    while True:
        job = client.jobs.get(job_id)
        status = job.get("status")
        if status in ("completed", "succeeded", "failed", "error"):
            return job
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Job {job_id} did not finish within {timeout:.0f}s")
        time.sleep(interval)


def extract_job_id(response: dict[str, Any]) -> Optional[str]:
    """Pull a job id out of a 202-style response, tolerating field variants.

    The async endpoints return the id under one of a few keys depending on
    the resource; check them all so callers do not have to.
    """
    for key in ("jobId", "job_id", "id"):
        value = response.get(key)
        if isinstance(value, str) and value.startswith("job_"):
            return value
    job = response.get("job")
    if isinstance(job, dict):
        return extract_job_id(job)
    return None


def first(page_or_list: Any) -> Optional[dict[str, Any]]:
    """Return the first item of a SDK page / list response, or ``None``.

    Works for both :class:`facturino.SyncPage` (iterable) and the plain
    ``{"data": [...]}`` dicts returned by the non-paginated list endpoints.
    """
    if hasattr(page_or_list, "data"):
        data = page_or_list.data
    elif isinstance(page_or_list, dict):
        data = page_or_list.get("data", [])
    else:
        data = list(page_or_list)
    return data[0] if data else None


def run_step(label: str, fn: Callable[[], Any], log: list[dict[str, Any]]) -> Any:
    """Run one scenario step, append a structured log entry, and return its result.

    On an :class:`ApiError`, the entry records the error (with ``request_id``)
    and the exception is re-raised so the caller decides whether the step is
    fatal or optional.
    """
    try:
        result = fn()
        log.append({"step": label, "ok": True})
        return result
    except ApiError as exc:
        log.append({"step": label, "ok": False, **describe_error(exc)})
        raise
