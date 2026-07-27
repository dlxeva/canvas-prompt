# Security policy

Canvas Prompt is local-first. Security-sensitive issues include project
boundary escapes, unintended file reads or writes, archive leakage, recording
or transcript exposure, unsafe localhost access, dependency compromise, and
credential exposure.

## Reporting a vulnerability

Please do not publish an exploit, private archive, recording, transcript, or
credential in a public issue. Use GitHub's private vulnerability reporting for
this repository when it is available. If it is not enabled, contact the
repository owner privately through GitHub before opening an issue.

Include:

- affected version or commit;
- operating system and host integration;
- minimal reproduction steps;
- impact and any known workaround;
- whether test material includes private canvas data.

## Supported line

Only the current `main` branch and the latest published plugin version receive
security fixes during the alpha. Older caches and local forks may require a
manual update after a fix is published.
