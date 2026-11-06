# freeitsm-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server for the [FreeITSM](https://github.com/edmozley/freeitsm) REST API (`/api/v1`).
It exposes **94 tools** (55 read, 30 write, 9 admin): tickets, assets, problems, changes, knowledge, tasks, CMDB, contracts, service status, requesters and reference data.

## Quick start

```bash
npm ci
npm run build
FREEITSM_BASE_URL=https://itsm.example.com FREEITSM_API_KEY=fitsm_... node dist/index.js
```

Claude Desktop / MCP client config (stdio):

```json
{
  "mcpServers": {
    "freeitsm": {
      "command": "node",
      "args": ["/path/to/freeitsm-mcp/dist/index.js"],
      "env": {
        "FREEITSM_BASE_URL": "https://itsm.example.com",
        "FREEITSM_API_KEY": "fitsm_...",
        "FREEITSM_TOOL_TIERS": "read,write"
      }
    }
  }
}
```

## Auth setup

1. In FreeITSM, create an API key (System > API). Keys look like `fitsm_...`.
2. Give the key only the per-module permissions you need (for example `tickets.read`, `ticket_notes.create`). Each tool below lists the permission it needs. `freeitsm_ping` needs none and reports what the key is allowed to do.
3. Set `FREEITSM_BASE_URL` (the install root, without `/api/v1`) and `FREEITSM_API_KEY`.

The key is sent as `Authorization: Bearer <key>`. It is never logged and is redacted from error messages. A `403 forbidden` is returned as a tool error naming the missing permission.

## Configuration

| Variable | Description |
|---|---|
| `FREEITSM_BASE_URL` | FreeITSM install URL. https only (http allowed for `localhost`/`127.0.0.1`). Userinfo, query strings and fragments are rejected. Redirects are never followed. https to private/internal IPs is allowed on purpose: only the operator sets the base URL (it is never taken from a request), so this is not a per-request SSRF path. |
| `FREEITSM_API_KEY` | API key (env auth mode). |
| `FREEITSM_TOOL_TIERS` | Comma-separated tiers to expose: `read`, `write`, `admin`. Default `read`. Tools outside the enabled tiers are neither listed nor callable. |
| `AUTH_MODE` | `env` (default) or `gateway` (HTTP transport only). |
| `MCP_TRANSPORT` | `stdio` (default) or `http`. |
| `MCP_HTTP_PORT` / `MCP_HTTP_HOST` | HTTP listen port (default 8080) and host (default `127.0.0.1`; the container sets `0.0.0.0`). |
| `CONDUIT_S2S_SECRET` | Required for the HTTP transport; must be at least 32 characters and not a placeholder (startup fails otherwise); requests must carry a valid `X-Gateway-S2S` header. |
| `MCP_ALLOW_INSECURE_DEV` | `1` allows an empty secret for local development; binds `127.0.0.1` only. |
| `MCP_ALLOWED_HOSTS` | Comma-separated extra `Host` header values (hostname only: no port; IPv6 in brackets) accepted on the HTTP transport, in addition to `localhost`, `127.0.0.1`, `[::1]`. Mismatches get HTTP 403 (DNS-rebinding protection). The check is always on for loopback binds, in insecure-dev mode, or when this variable is set; set it to your public hostname when binding `0.0.0.0` behind a proxy. |
| `FREEITSM_CA_CERT_FILE` | Optional PEM CA bundle for installs behind a private CA. |
| `LOG_LEVEL` | `debug`, `info` (default), `warn`, `error`. |

See [.env.example](.env.example).

## Tiers

- **read** (55): GET endpoints. The default.
- **write** (30): create/update/link/cancel/restore (POST and PATCH).
- **admin** (9): DELETE endpoints. Descriptions start with `⚠ DESTRUCTIVE` and say whether the delete moves to trash/recycle bin or is permanent. `npm run lint:destructive` enforces this.

## Gateway mode

Run `MCP_TRANSPORT=http AUTH_MODE=gateway` behind a gateway that signs requests with `X-Gateway-S2S` (`CONDUIT_S2S_SECRET`) and supplies each user's key in the `X-FreeITSM-Key` header on every request. In gateway mode the server never falls back to `FREEITSM_API_KEY`; a request without the header gets HTTP 401. `FREEITSM_BASE_URL` is still read from the environment. `/health` is unauthenticated and never reads credentials.

```bash
docker compose up   # requires CONDUIT_S2S_SECRET
```

## API behaviour

- Success bodies are `{data, meta?}`. Tools return `{"data": ..., "meta": ...}`, with `meta` carrying pagination (`page`, `per_page`, `total`, `total_pages`). List tools take `page` and `per_page` (max 100).
- Errors are `{error:{code,message,details?}}`; tool errors read `FreeITSM error <code> (HTTP <status>): <message>`.
- HTTP 429 is retried once, after `Retry-After` (up to 30s); otherwise it is returned as a tool error.
- Path parameters are URL-encoded. Write tools send any extra arguments through as JSON body fields.

## Tools

| Tool | Tier | Permission | Description |
|---|---|---|---|
| `freeitsm_ping` | read | - | Check a key works. |
| `freeitsm_tickets_list` | read | `tickets.read` | List / search tickets. |
| `freeitsm_ticket_create` | write | `tickets.create` | Create a ticket. |
| `freeitsm_ticket_get` | read | `tickets.read` | Get one ticket. |
| `freeitsm_ticket_update` | write | `tickets.update` | Update a ticket. |
| `freeitsm_ticket_delete` | admin | `tickets.delete` | ⚠ DESTRUCTIVE: moves the ticket to trash (soft delete); restore it with freeitsm_ticket_restore. |
| `freeitsm_ticket_restore` | write | `tickets.restore` | Restore from trash. |
| `freeitsm_ticket_notes_list` | read | `ticket_notes.read` | List notes. |
| `freeitsm_ticket_note_add` | write | `ticket_notes.create` | Add a note. |
| `freeitsm_ticket_thread_get` | read | `ticket_thread.read` | Get the conversation. |
| `freeitsm_ticket_audit_get` | read | `ticket_audit.read` | Get the change history. |
| `freeitsm_ticket_sla_get` | read | `ticket_sla.read` | Get live SLA state. |
| `freeitsm_ticket_time_entries_list` | read | `ticket_time_entries.read` | List time entries. |
| `freeitsm_ticket_time_entry_log` | write | `ticket_time_entries.create` | Log time. |
| `freeitsm_ticket_time_entry_delete` | admin | `ticket_time_entries.delete` | ⚠ DESTRUCTIVE: soft-deletes the time entry (moves to trash). |
| `freeitsm_assets_list` | read | `assets.read` | List / search assets. |
| `freeitsm_asset_create` | write | `assets.create` | Create an asset. |
| `freeitsm_asset_get` | read | `assets.read` | Get one asset. |
| `freeitsm_asset_update` | write | `assets.update` | Update an asset. |
| `freeitsm_asset_assignments_list` | read | `asset_assignments.read` | Who has it. |
| `freeitsm_asset_assign` | write | `asset_assignments.create` | Assign (check out). |
| `freeitsm_asset_unassign` | admin | `asset_assignments.delete` | ⚠ DESTRUCTIVE: removes the asset assignment (check-in) for this user; the change is recorded in the custody log and asset history. |
| `freeitsm_asset_history_get` | read | `asset_history.read` | Change history. |
| `freeitsm_asset_disks_list` | read | `asset_inventory.read` | Disks. |
| `freeitsm_asset_network_adapters_list` | read | `asset_inventory.read` | Network adapters. |
| `freeitsm_asset_software_list` | read | `asset_inventory.read` | Installed software. |
| `freeitsm_problems_list` | read | `problems.read` | List / search problems. |
| `freeitsm_problem_create` | write | `problems.create` | Create a problem. |
| `freeitsm_problem_get` | read | `problems.read` | Get one problem. |
| `freeitsm_problem_update` | write | `problems.update` | Update a problem. |
| `freeitsm_problem_delete` | admin | `problems.delete` | ⚠ DESTRUCTIVE: PERMANENTLY deletes the problem and everything attached (links, notes, audit trail). |
| `freeitsm_problem_notes_list` | read | `problem_notes.read` | Read the journal. |
| `freeitsm_problem_note_add` | write | `problem_notes.create` | Add a journal note. |
| `freeitsm_problem_ticket_link` | write | `problem_links.create` | Link an incident. |
| `freeitsm_changes_list` | read | `changes.read` | List / search changes. |
| `freeitsm_change_create` | write | `changes.create` | Create a change. |
| `freeitsm_change_get` | read | `changes.read` | Get one change. |
| `freeitsm_change_update` | write | `changes.update` | Update a change. |
| `freeitsm_change_delete` | admin | `changes.delete` | ⚠ DESTRUCTIVE: PERMANENTLY deletes the change, its attachments and all children (comments, CAB, audit). |
| `freeitsm_change_comments_list` | read | `change_comments.read` | List comments. |
| `freeitsm_change_comment_add` | write | `change_comments.create` | Add a comment. |
| `freeitsm_change_audit_get` | read | `change_audit.read` | Change history. |
| `freeitsm_change_approvals_list` | read | `change_approvals.read` | Approval rounds. |
| `freeitsm_change_cancel` | write | `changes.update` | Cancel a change. |
| `freeitsm_knowledge_articles_list` | read | `knowledge.read` | List / search articles. |
| `freeitsm_knowledge_article_create` | write | `knowledge.create` | Create an article. |
| `freeitsm_knowledge_article_get` | read | `knowledge.read` | Get one article. |
| `freeitsm_knowledge_article_update` | write | `knowledge.update` | Update an article. |
| `freeitsm_knowledge_article_delete` | admin | `knowledge.delete` | ⚠ DESTRUCTIVE: moves the article to the recycle bin (soft archive; restorable until the retention window purges it). |
| `freeitsm_tasks_list` | read | `tasks.read` | List / board feed. |
| `freeitsm_task_create` | write | `tasks.create` | Create a task. |
| `freeitsm_task_get` | read | `tasks.read` | Get one task. |
| `freeitsm_task_update` | write | `tasks.update` | Update a task. |
| `freeitsm_task_delete` | admin | `tasks.delete` | ⚠ DESTRUCTIVE: PERMANENTLY deletes the task with its subtasks, comments and tag links. |
| `freeitsm_task_comments_list` | read | `task_comments.read` | List comments. |
| `freeitsm_task_comment_add` | write | `task_comments.create` | Add a comment. |
| `freeitsm_cmdb_classes_list` | read | `cmdb_classes.read` | List classes. |
| `freeitsm_cmdb_objects_list` | read | `cmdb_objects.read` | List / search objects. |
| `freeitsm_cmdb_object_create` | write | `cmdb_objects.create` | Create an object. |
| `freeitsm_cmdb_object_get` | read | `cmdb_objects.read` | Get one object. |
| `freeitsm_cmdb_object_update` | write | `cmdb_objects.update` | Update an object. |
| `freeitsm_cmdb_object_impact_get` | read | `cmdb_objects.read` | Impact analysis. |
| `freeitsm_cmdb_object_tickets_list` | read | `cmdb_ticket_links.read` | Linked tickets. |
| `freeitsm_cmdb_object_ticket_link` | write | `cmdb_ticket_links.create` | Link a ticket. |
| `freeitsm_contracts_list` | read | `contracts.read` | List / search contracts. |
| `freeitsm_contract_get` | read | `contracts.read` | Get one contract. |
| `freeitsm_services_list` | read | `services.read` | The health board. |
| `freeitsm_service_create` | write | `services.create` | Add a service. |
| `freeitsm_service_get` | read | `services.read` | Get one service. |
| `freeitsm_service_update` | write | `services.update` | Update a service. |
| `freeitsm_service_delete` | admin | `services.delete` | ⚠ DESTRUCTIVE: PERMANENTLY removes the service and its incident links (incidents themselves remain). |
| `freeitsm_incidents_list` | read | `service_incidents.read` | List incidents. |
| `freeitsm_incident_create` | write | `service_incidents.create` | Open an incident. |
| `freeitsm_incident_get` | read | `service_incidents.read` | Get one incident. |
| `freeitsm_incident_update` | write | `service_incidents.update` | Update / resolve. |
| `freeitsm_incident_delete` | admin | `service_incidents.delete` | ⚠ DESTRUCTIVE: PERMANENTLY removes the incident and its service links. |
| `freeitsm_jobs_health_get` | read | `job_health.read` | Background job health. |
| `freeitsm_users_list` | read | `users.read` | List / search requesters. |
| `freeitsm_user_get` | read | `users.read` | Get a requester. |
| `freeitsm_user_create` | write | `users.create` | Create a requester. |
| `freeitsm_user_update` | write | `users.update` | Update a requester. |
| `freeitsm_analysts_list` | read | `analysts.read` | List analysts. |
| `freeitsm_companies_list` | read | `companies.read` | List companies. |
| `freeitsm_ticket_statuses_list` | read | `reference.read` | List ticket statuses. |
| `freeitsm_priorities_list` | read | `reference.read` | List priorities. |
| `freeitsm_ticket_types_list` | read | `reference.read` | List ticket types. |
| `freeitsm_origins_list` | read | `reference.read` | List ticket origins. |
| `freeitsm_departments_list` | read | `reference.read` | List departments. |
| `freeitsm_asset_types_list` | read | `reference.read` | List asset types. |
| `freeitsm_asset_statuses_list` | read | `reference.read` | List asset statuses. |
| `freeitsm_suppliers_list` | read | `reference.read` | List suppliers. |
| `freeitsm_problem_statuses_list` | read | `reference.read` | List problem statuses. |
| `freeitsm_change_statuses_list` | read | `reference.read` | List change statuses. |
| `freeitsm_change_types_list` | read | `reference.read` | List change types. |

## Development

```bash
npm ci
npm run build && npm test && npm run lint && npm run lint:destructive && npm run typecheck && npm run smoke
```

All tests mock `fetch`; the smoke script talks only to a local mock on 127.0.0.1. Nothing contacts a real FreeITSM host.

## Upstream license

FreeITSM ([github.com/edmozley/freeitsm](https://github.com/edmozley/freeitsm)) is released under the MIT License, the same license as this project, so the two are compatible. This MCP server is an independent client of FreeITSM's REST API and copies no FreeITSM code. The endpoint list was derived from the public `api/v1/spec.json`.

## License

MIT. See [LICENSE](LICENSE).
