"""Stable import surface for the additive MCPack-02 continuity adapter."""

try:  # package import
    from .build_context_continuity import (  # type: ignore
        CONTINUITY_STATUSES,
        CONTINUITY_VERSION,
        ANSWER_CONTRACT_VERSION,
        ANSWER_OPENING_SECTIONS,
        ANSWER_SECTION_ORDER,
        IDENTITY_RECEIPT_FIELDS,
        USER_VISIBLE_RECEIPT_FIELDS,
        READ_MODES,
        RECONCILIATION_STATUSES,
        build_context_continuity_policy,
        build_context_handoff,
        build_context_reconciliation,
        build_continuity_response_policy,
        build_reconciled_response_policy,
        mark_context_response_superseded,
        reconcile_context_pack,
        reconcile_context_response,
    )
    from .validate_context_continuity import (  # type: ignore
        validate_context_continuity_policy,
        validate_context_handoff,
        validate_continuity_policy,
        validate_package,
        validate_reconciled_response_policy,
    )
except ImportError:  # existing script-style imports
    from build_context_continuity import (  # noqa: F401
        CONTINUITY_STATUSES,
        CONTINUITY_VERSION,
        ANSWER_CONTRACT_VERSION,
        ANSWER_OPENING_SECTIONS,
        ANSWER_SECTION_ORDER,
        IDENTITY_RECEIPT_FIELDS,
        USER_VISIBLE_RECEIPT_FIELDS,
        READ_MODES,
        RECONCILIATION_STATUSES,
        build_context_continuity_policy,
        build_context_handoff,
        build_context_reconciliation,
        build_continuity_response_policy,
        build_reconciled_response_policy,
        mark_context_response_superseded,
        reconcile_context_pack,
        reconcile_context_response,
    )
    from validate_context_continuity import (  # noqa: F401
        validate_context_continuity_policy,
        validate_context_handoff,
        validate_continuity_policy,
        validate_package,
        validate_reconciled_response_policy,
    )


__all__ = [
    "CONTINUITY_STATUSES",
    "CONTINUITY_VERSION",
    "ANSWER_CONTRACT_VERSION",
    "ANSWER_OPENING_SECTIONS",
    "ANSWER_SECTION_ORDER",
    "IDENTITY_RECEIPT_FIELDS",
    "USER_VISIBLE_RECEIPT_FIELDS",
    "READ_MODES",
    "RECONCILIATION_STATUSES",
    "build_context_continuity_policy",
    "build_continuity_response_policy",
    "build_context_handoff",
    "build_context_reconciliation",
    "build_reconciled_response_policy",
    "reconcile_context_response",
    "reconcile_context_pack",
    "mark_context_response_superseded",
    "validate_context_continuity_policy",
    "validate_context_handoff",
    "validate_continuity_policy",
    "validate_reconciled_response_policy",
    "validate_package",
]
