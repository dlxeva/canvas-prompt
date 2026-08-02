# Controlled Interaction Review I0 snapshot

This directory is the browser-runtime subset of the controlled Interaction
Review I0 experiment. Canvas Prompt exposes it from the Interactive Review
entry as a built-in synthetic prototype.

Current boundary:

- four fixed synthetic routes;
- explicit review sessions only;
- no arbitrary URL or user bundle;
- deny-all network declaration and no background monitoring;
- sensitive input values excluded;
- visible Agent walkthrough uses fixed steps;
- proposals remain `proposal-only` and `execution_authorized=false`.

This snapshot is intentionally self-contained. When the canonical controlled
experiment changes, update it deliberately and rerun both the I0 contract
suite and Canvas Prompt's Artifact Review browser regression.
