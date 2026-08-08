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
    from .build_context_response_policy import (  # type: ignore
        build_context_response_policy,
        build_evidence_layered_response_policy,
        build_layered_answer_policy,
        build_response_policy,
        build_understanding_response_policy,
    )
    from .validate_context_response_policy import (  # type: ignore
        validate_context_response_policy,
        validate_layered_answer_policy,
        validate_package,
        validate_policy,
        validate_response_policy,
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
    from build_context_response_policy import (  # noqa: F401
        build_context_response_policy,
        build_evidence_layered_response_policy,
        build_layered_answer_policy,
        build_response_policy,
        build_understanding_response_policy,
    )
    from validate_context_response_policy import (  # noqa: F401
        validate_context_response_policy,
        validate_layered_answer_policy,
        validate_package,
        validate_policy,
        validate_response_policy,
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
    "build_context_response_policy",
    "build_understanding_response_policy",
    "build_layered_answer_policy",
    "build_evidence_layered_response_policy",
    "build_response_policy",
    "validate_context_response_policy",
    "validate_response_policy",
    "validate_layered_answer_policy",
    "validate_package",
    "validate_policy",
]
