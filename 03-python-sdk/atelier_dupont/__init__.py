"""Atelier Dupont — Facturino python-sdk demo.

A minimal SaaS backend whose billing runs entirely on Facturino. See the
package README for the step -> SDK-method coverage table.
"""

from __future__ import annotations

__all__ = ["create_app"]


def create_app():  # noqa: ANN201 - thin re-export, typed in app.py
    """Re-export the Flask application factory (see :mod:`atelier_dupont.app`)."""
    from .app import create_app as _create_app

    return _create_app()
