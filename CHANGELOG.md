# Changelog

## [Unreleased]

### Security
- Gateway mode never falls back to environment credentials in tool calls.
- `CONDUIT_S2S_SECRET` must be >= 32 characters (placeholders already rejected).
- Host-header (DNS-rebinding) check with `MCP_ALLOWED_HOSTS`; 403 on mismatch.
- 1 MiB limit on `/mcp` request bodies (HTTP 413).
- Path parameters reject empty, `.`, `..` and slash-containing values; undeclared arguments are no longer forwarded upstream.
- Upstream error message/details are redacted then truncated to 500 characters.
- CI reusable-workflow references moved to the org namespaces; `mcp-assert` has `permissions: contents: read`.
- Added `.dockerignore`.

### Added
- Initial FreeITSM MCP server: 94 tools (55 read, 30 write, 9 admin) over the api/v1 REST API.
