# Portfolio media

The media in this directory is captured from the local synthetic operator console. It is intended
to make the portfolio story inspectable, not to represent a real customer or vendor deployment.

Captured artifacts:

- `console-overview.png` — operator overview with seeded synthetic orders and exception counts.
- `console-overview.webm` — short browser recording of the same console loading and refreshing.
- [`../ARCHITECTURE.svg`](../ARCHITECTURE.svg) — checked-in ownership and message-flow diagram.

Capture requirements:

1. Use `APP_ENV=test`, the deterministic seed data, and only synthetic operator headers.
2. Review the frame for credentials, raw payloads, private URLs, and customer data before sharing.
3. Keep the `.invalid` carrier URL and synthetic labels visible so the adapter boundary is clear.
4. Do not present screenshots or video as evidence of a real vendor integration.
