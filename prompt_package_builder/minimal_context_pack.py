"""Stable import surface for the MCPack-01 adapter."""

try:  # package import
    from .build_minimal_context_pack import (  # type: ignore
        CONTRACT,
        CONTEXT_VERSION,
        build_context_pack,
        build_minimal_context_pack,
        build_model_envelope,
        adapt,
        main,
        read_json,
        write_json,
    )
except ImportError:  # existing script-style imports
    from build_minimal_context_pack import (  # noqa: F401
        CONTRACT,
        CONTEXT_VERSION,
        build_context_pack,
        build_minimal_context_pack,
        build_model_envelope,
        adapt,
        main,
        read_json,
        write_json,
    )

__all__ = [
    "CONTRACT",
    "CONTEXT_VERSION",
    "build_minimal_context_pack",
    "build_context_pack",
    "build_model_envelope",
    "adapt",
    "main",
    "read_json",
    "write_json",
]
