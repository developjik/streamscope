# Changelog

## 0.1.1

- `record`: credential headers (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `proxy-authorization`) are now stored as `[redacted]` in traces by default; `--no-redact` records them verbatim and prints a warning (DEV-26).
- `record`: the proxy now picks `http`/`https` transport from the target URL instead of always using `node:http`, so `https:` targets proxy correctly; `ProxyOptions.agent` allows custom TLS agents (DEV-43).
- `record`: unsupported target protocols are refused at startup, malformed request targets return 400/502 responses, and request-handler errors end as HTTP responses instead of unhandled rejections that could kill the proxy (DEV-43).
- Docs: README Limitations updated to match actual proxy behavior (header redaction, `accept-encoding` stripping).

## 0.1.0

- Initial release: recording reverse proxy + middleware, SSE/NDJSON/JSON adapters (AI SDK, AG-UI), frame-level replay server, fault-injection DSL, timeline panel, Playwright fixture.
