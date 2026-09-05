"""Stable import surface for the MCPack-02 response policy."""

try:  # package import
    from .build_context_response_policy import (  # type: ignore
        ANSWER_ORDER,
        CONTRACT,
        POLICY_VERSION,
        REQUEST_KINDS,
        SNAPSHOT_GATED_REQUEST_KINDS,
        adapt,
        build_context_response_policy,
        build_evidence_layered_response_policy,
        build_layered_answer_policy,
        build_response_policy,
        build_understanding_response_policy,
        main,
        read_json,
        write_json,
    )
    from .validate_context_response_policy import (  # type: ignore
        validate_context_response_policy,
        validate_layered_answer_policy,
        validate_package,
        validate_policy,
        validate_response_policy,
    )
except ImportError:  # existing script-style imports
    from build_context_response_policy import (  # noqa: F401
        ANSWER_ORDER,
        CONTRACT,
        POLICY_VERSION,
        REQUEST_KINDS,
        SNAPSHOT_GATED_REQUEST_KINDS,
        adapt,
        build_context_response_policy,
        build_evidence_layered_response_policy,
        build_layered_answer_policy,
        build_response_policy,
        build_understanding_response_policy,
        main,
        read_json,
        write_json,
    )
    from validate_context_response_policy import (  # noqa: F401
        validate_context_response_policy,
        validate_layered_answer_policy,
        validate_package,
        validate_policy,
        validate_response_policy,
    )


__all__ = [
    "ANSWER_ORDER",
    "CONTRACT",
    "POLICY_VERSION",
    "REQUEST_KINDS",
    "SNAPSHOT_GATED_REQUEST_KINDS",
    "build_context_response_policy",
    "build_understanding_response_policy",
    "build_layered_answer_policy",
    "build_evidence_layered_response_policy",
    "build_response_policy",
    "adapt",
    "validate_context_response_policy",
    "validate_response_policy",
    "validate_layered_answer_policy",
    "validate_package",
    "validate_policy",
    "main",
    "read_json",
    "write_json",
]
