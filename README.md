# grok-bot-fifo

This repo is the **queue**. Agents do not chat with it. They enqueue work, claim a seat, stall-chase, and mark items done. The Worker stores that state in Cloudflare D1 and, when something important happens, POSTs a signed CloudEvent to a **Grok Bot webhook routine**.

The bot that receives those POSTs is **not** in this repo. It is the **FIFO Ops** Grok Bot template. A new owner installs this Worker first, then imports that template and wires three secrets. After that, the template’s `fifo-ops-getting-started` skill can finish the rest (API URL, vault credentials, assigner, exec surface, seats).

- **Repo:** https://github.com/bradmb/grok-bot-fifo
- **License:** MIT
- **Secrets:** never commit tokens, Access credentials, webhook URLs, or `Authorization` values

## What the queue does

- **Personal queues** (`personal:<agent>`) — one in-progress seat per owner. Extra work stays queued and the response can include a share link.
- **Eng team FIFO** (`team:eng`) — N named IC seats. `claim-next` fills Factory seats. `claim-cr` fills a parallel Code Review lane that does not consume Factory capacity.
- **Parked hold lane** (`team:parked`) — capacity 0, not claimable. Items move between eng and parked.
- **Hard-block** holds a seat. `clear-block` unblocks without releasing it.
- **Stall clock** — Factory in-progress items stall after a run of business minutes (default America/Denver, 08:00–17:00, 60 minutes).
- **Share boards** — `GET /s/<token>` renders Queued | In Progress | Code Review. The token is the bearer. No other secrets on that page.
- **Webhook outbox** — CloudEvents 1.0, HMAC-signed, delivered immediately with cron retry.

## What you need

- Node.js 22+ and npm
- A Cloudflare account with Workers and D1
- The **FIFO Ops** Grok Bot template (imported after the Worker is live)
- For production: Cloudflare Zero Trust Access with a service token on the API host

You will work in this order: clone and test → log in → create D1 → migrate → deploy → fill `[vars]` → put secrets → seed a hashed bearer → smoke test → **hook FIFO Ops**.

## 1. Clone, install, and test

```bash
git clone https://github.com/bradmb/grok-bot-fifo.git
cd grok-bot-fifo
npm ci
npm test
npm run typecheck
```

If tests fail, stop. Do not deploy a Worker you have not proven locally.

## 2. Log in to Cloudflare

```bash
npx wrangler login
npx wrangler whoami
```

`whoami` prints the Cloudflare `account_id`. You will paste that into `wrangler.toml`. Do not invent one.

## 3. Create D1 and paste IDs into `wrangler.toml`

```bash
npx wrangler d1 create fifo-worker
```

Wrangler prints a `database_id`. Copy **that** value into `wrangler.toml`. Do not invent an id and do not commit someone else’s.

```toml
[[d1_databases]]
binding = "DB"
database_name = "fifo-worker"
database_id = "<from-wrangler-d1-create>"
migrations_dir = "migrations"
```

Uncomment `account_id` at the top of `wrangler.toml` and paste the id from `wrangler whoami`.

Leave `workers_dev = true` for the first deploy. Custom hostnames come in step 6.

## 4. Apply migrations

Local D1 (needed for `wrangler dev`):

```bash
npx wrangler d1 migrations apply fifo-worker --local
```

Production D1 (needed before the first remote deploy can serve queues):

```bash
npx wrangler d1 migrations apply fifo-worker --remote
```

Migrations seed agents, `team:eng` seats (`ic1`–`ic6`), and the parked lane. They do **not** seed API clients or secrets.

## 5. Deploy the Worker

```bash
npx wrangler deploy
```

Note the Worker URL, for example `https://fifo-worker.<account>.workers.dev`. That origin is `FIFO_API` for the CLI and for agents until you attach custom hosts.

On `*.workers.dev` the Worker serves both `/v1/*` (API) and `/s/*` (share boards). Share links use the request origin.

## 6. Hosts and `[vars]`

These names match live `wrangler.toml`. Edit the committed `[vars]` block; do not add extra keys.

| Var | Default in `wrangler.toml` | What to put |
|---|---|---|
| `FIFO_API_HOST` | `fifo-api.<your-domain>` | Hostname that serves `/v1/*` only |
| `FIFO_SHARE_HOST` | `fifo-share.<your-domain>` | Hostname that serves `/s/*` only |
| `SHARE_PUBLIC_ORIGIN` | `https://fifo-share.<your-domain>` | Public origin used when minting share links |
| `CF_ACCESS_TEAM_DOMAIN` | `https://<your-team>.cloudflareaccess.com` | Access team domain (JWT issuer / JWKS) |
| `AUTH_REQUIRED` | `"true"` | Keep `true` in production. Set `false` only in gitignored `.dev.vars` for localhost |
| `ENG_CAPACITY` | `"6"` | Factory in-progress seats on `team:eng` (migrations seed six ICs) |
| `STALL_TZ` | `America/Denver` | Stall-clock timezone |
| `STALL_START_HOUR` | `"8"` | Stall window start (wall-clock hour) |
| `STALL_END_HOUR` | `"17"` | Stall window end (wall-clock hour, exclusive) |
| `STALL_BUSINESS_MINUTES` | `"60"` | Business minutes of silence before `item.stalled` |

For a first deploy you can leave the hostname placeholders and keep `workers_dev = true`. The Worker still works on `*.workers.dev`.

When you are ready to split an authenticated API from a public share board:

1. Create DNS for `fifo-api.<your-domain>` and `fifo-share.<your-domain>`.
2. Set `FIFO_API_HOST`, `FIFO_SHARE_HOST`, `SHARE_PUBLIC_ORIGIN`, and `CF_ACCESS_TEAM_DOMAIN` to your real values.
3. Uncomment `routes` in `wrangler.toml`. After Access is live on the API host, set `workers_dev = false` so the API is not also exposed on `*.workers.dev`.
4. Create a Cloudflare Zero Trust **Access** application on the API host with a **service-token** policy for machines and agents.
5. Leave the share host **without** Access. `/s/<token>` is its own bearer.
6. Put the Access application audience in the `CF_ACCESS_AUD` secret (next step).

The Worker enforces the split: share routes 404 on the API host, and API routes 404 on the share host.

Redeploy after you change `[vars]`:

```bash
npx wrangler deploy
```

## 7. Secrets (`wrangler secret put`)

Never commit these. Wrangler prompts for the value; it does not echo it into git.

```bash
npx wrangler secret put WEBHOOK_HMAC_SECRET
npx wrangler secret put WEBHOOK_DISPATCH_URL
npx wrangler secret put WEBHOOK_DISPATCH_AUTHORIZATION
npx wrangler secret put CF_ACCESS_AUD
```

| Secret | Purpose |
|---|---|
| `WEBHOOK_HMAC_SECRET` | Shared HMAC-SHA256 key. The Worker signs every POST with `Fifo-Signature`. The FIFO Ops routine may verify the same secret. |
| `WEBHOOK_DISPATCH_URL` | Webhook URL from the FIFO Ops routine. Empty or unset = stub delivery (rows stay in D1 as `stubbed`; nothing is POSTed). That is fine until you finish the next section. |
| `WEBHOOK_DISPATCH_AUTHORIZATION` | Full `Authorization` header value from that same routine (usually `Bearer …`, copied exactly). |
| `CF_ACCESS_AUD` | Access application audience for JWT verification on the API host. Skip until Access is attached. |

Client bearer hashes live in D1 (`api_clients.secret_hash`), not in Wrangler secrets. Seed those next.

## 8. Seed `api_clients` (hashed bearer)

Callers authenticate with one of:

- Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`, added by Access in front of the API host)
- Access service token headers (`CF-Access-Client-Id` / `CF-Access-Client-Secret`)
- `Authorization: Bearer <token>` whose SHA-256 matches `secret_hash`

Only the **hash** is stored. Hash the client secret (or bearer token) on your machine — never paste the raw value into git or chat:

```bash
printf '%s' "$CLIENT_SECRET" | openssl dgst -sha256 | awk '{print $NF}'
```

The printed hex digest is `secret_hash`. For an Access service token, `client_id` is the token’s Client ID and `secret_hash` is the SHA-256 of its Client Secret.

```sql
INSERT INTO api_clients (id, client_id, secret_hash, agent_id, permissions_json, name, created_at)
VALUES (
  lower(hex(randomblob(16))),
  '<access-client-id-or-bearer-client-key>',
  '<sha256-hex of the secret>',
  'dispatcher',
  '["dispatcher"]',
  'Dispatcher Grok Bot',
  datetime('now')
);
```

```bash
npx wrangler d1 execute fifo-worker --remote --command "<sql>"
```

Permissions:

| Permission | Grants |
|---|---|
| `dispatcher` | Full queue ops: claim, cancel, move, sync, team share, act as another agent via `X-Fifo-Actor` |
| `runner` | Move eng ↔ parked; progress / done / block on any item |
| `team:eng:enqueue` | Enqueue on `team:eng` (and `team:parked`) |
| `team:parked:enqueue` | Enqueue on `team:parked` |
| `team:eng:progress` | Progress / done / block on items |
| `personal:own` | Label for personal-queue clients. A client bound to an agent can already enqueue, mutate, and mint shares on its own `personal:<agent>` queue |

Keep `ENG_CAPACITY` in `wrangler.toml` in sync with seeded Factory seats (default `6`).

## 9. Smoke test

```bash
export FIFO_API=https://fifo-worker.<account>.workers.dev   # or https://fifo-api.<your-domain>
curl -s "$FIFO_API/health"
# {"ok":true,"service":"fifo-worker"}
```

`GET /health` is public. Queue APIs need credentials from your vault — do not paste secrets into chat:

```bash
curl -s "$FIFO_API/v1/queues/team:eng" \
  -H "CF-Access-Client-Id: $FIFO_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $FIFO_ACCESS_CLIENT_SECRET" \
  -H "X-Fifo-Actor: dispatcher"
```

Or with the CLI (same env names the FIFO Ops skill will ask you to vault):

```bash
export FIFO_API=https://fifo-worker.<account>.workers.dev
export FIFO_ACCESS_CLIENT_ID=…
export FIFO_ACCESS_CLIENT_SECRET=…
export FIFO_ACTOR=dispatcher

npm link   # or: node ./cli/fifo.mjs …
fifo queue show --team eng
```

If `/health` is not `ok`, the Worker did not deploy. If the queue call is `401`, the `api_clients` hash or Access headers are wrong. If the queue call is `200` and `WEBHOOK_DISPATCH_URL` is still empty, that is expected: outbox rows are `stubbed` until you hook FIFO Ops.

## Hook into the FIFO Ops Grok Bot template

This is the handoff the `fifo-ops-getting-started` skill expects. The Worker is the queue authority. FIFO Ops is the bot that wakes when the queue changes. Do not skip this section and do not invent a second queue.

### 1. Import or open FIFO Ops

In Grok Bot, import (or open) the **FIFO Ops** template. The getting-started skill on that bot tells you to deploy `grok-bot-fifo` first (this README) and then wire the webhook. You are on that step now.

### 2. Create a webhook routine

On that bot, create a **webhook routine**. A clear name is **FIFO Worker lane webhooks**. This is the URL the Worker will POST to.

### 3. Copy routine values into Worker secrets

From the routine sidebar, copy two fields. Put them on the Worker with `wrangler secret put` (paste when prompted; do not commit):

| From the FIFO Ops routine | Worker secret |
|---|---|
| **Webhook URL** | `WEBHOOK_DISPATCH_URL` |
| **Authorization** header value (usually `Bearer …`, copied exactly) | `WEBHOOK_DISPATCH_AUTHORIZATION` |

```bash
npx wrangler secret put WEBHOOK_DISPATCH_URL
# paste the routine Webhook URL

npx wrangler secret put WEBHOOK_DISPATCH_AUTHORIZATION
# paste the Authorization value exactly as Grok Bot shows it
```

### 4. Share one HMAC secret

Generate a long random string. Put the **same** value in both places:

- Worker secret `WEBHOOK_HMAC_SECRET`
- The FIFO Ops routine, if it asks for an HMAC / signing secret (it may verify `Fifo-Signature`)

```bash
npx wrangler secret put WEBHOOK_HMAC_SECRET
# paste the shared random string; store the same value on the routine
```

Until `WEBHOOK_DISPATCH_URL` is set, the Worker stubs dispatcher events in D1 and does not POST.

### 5. Continue the FIFO Ops getting-started walkthrough

Webhook wiring is the Worker’s last required step. Go back to the FIFO Ops skill and finish its remaining checklist:

- `FIFO_API` — the Worker base URL from step 5 (`https://fifo-worker.<account>.workers.dev` or `https://fifo-api.<your-domain>`)
- Vault Access / bearer — the same `FIFO_ACCESS_CLIENT_ID` / `FIFO_ACCESS_CLIENT_SECRET` (or `FIFO_BEARER`) you used in the smoke test
- Assigner, exec surface, and seats — configured on the bot, not in this repo

The skill will keep using this Worker as `FIFO_API`. There is no parallel queue file to create.

### What the Worker POSTs (CloudEvents + HMAC)

Each delivery is `POST` with `Content-Type: application/json` (not `application/cloudevents+json`) and a CloudEvents 1.0 body. Typical fields: `specversion`, `id`, `source` (`fifo-worker`), `type` (for example `item.enqueued`), `time`, `datacontenttype`, and `data` (queue key, item id, title).

Headers on every signed POST:

| Header | Value |
|---|---|
| `Fifo-Event-Id` | CloudEvent `id` |
| `Fifo-Timestamp` | ISO-8601 time of this delivery attempt |
| `Fifo-Signature` | `sha256=<hex>` HMAC-SHA256 of `{timestamp}.{eventId}.{rawBody}` using `WEBHOOK_HMAC_SECRET` |
| `Authorization` | `WEBHOOK_DISPATCH_AUTHORIZATION`, if set |

Dedupe on CloudEvent `id`. Retries reuse the same `id` and re-sign with a new timestamp. Reject a mismatched `Fifo-Signature` before the routine mutates queue state.

Only the `dispatcher` destination is POSTed to `WEBHOOK_DISPATCH_URL`. Other destinations are recorded in the outbox as `stubbed`.

| `type` | When it fires | What FIFO Ops typically does |
|---|---|---|
| `item.enqueued` | New claimable work on `team:eng` | If a Factory seat is free, claim the head |
| `item.assigned` | An item was claimed onto a seat | Wake the assignee (or assigner) |
| `item.stalled` | Factory in-progress went quiet past the stall clock | Chase the assignee |
| `item.done` | An item completed and `requester_ref` is set | Notify that requester when it is an agent id |
| `item.hard_blocked` / `item.hard_block_cleared` | Hard-block toggled on `team:eng` | Ops awareness; the seat stays held |
| `eng.hours.open` | Weekday open tick (06:00 America/Denver) | Drain queued heads while seats are free |

The Worker does **not** POST for parked-queue events, HOLD / STOP / parked titles, after-hours claimable noise, or move / reorder / progress / capacity chatter. Those still land in `item_events`.

## Local development

```bash
npm ci
npm test
npm run typecheck
npx wrangler d1 migrations apply fifo-worker --local
```

`wrangler.toml` defaults to production-shaped auth (`AUTH_REQUIRED = "true"`). For local smoke tests, put the following in `.dev.vars` (gitignored) and seed an `api_clients` row. Do not commit `.dev.vars`.

```bash
printf 'AUTH_REQUIRED=false\n' > .dev.vars
npx wrangler d1 execute fifo-worker --local --command \
  "INSERT OR IGNORE INTO api_clients (id, client_id, secret_hash, agent_id, permissions_json, name, created_at) VALUES ('local-dispatcher', 'dev-dispatcher', '', 'dispatcher', '[\"dispatcher\"]', 'Local dispatcher', datetime('now'))"
npx wrangler dev
```

On `localhost` / `127.0.0.1` with `AUTH_REQUIRED=false`, the Worker binds `CF-Access-Client-Id` (or `X-Fifo-Client`) to that row without checking a secret.

```bash
export FIFO_API=http://127.0.0.1:8787
curl -s "$FIFO_API/health"
# {"ok":true,"service":"fifo-worker"}

FIFO_ACCESS_CLIENT_ID=dev-dispatcher FIFO_ACTOR=dispatcher \
  node cli/fifo.mjs enqueue --team eng --title "Local smoke" --json
```

Without `WEBHOOK_DISPATCH_URL`, outbox rows are `stubbed`. Inspect them with:

```bash
npx wrangler d1 execute fifo-worker --local \
  --command "SELECT event_type, destination, status FROM webhook_outbox ORDER BY created_at"
```

## CLI

`cli/fifo.mjs` is the `fifo` bin (`npm link`, `npm i -g .`, or `node ./cli/fifo.mjs …`). Headless: no chat integrations.

| Variable | Purpose | Default |
|---|---|---|
| `FIFO_API` | Worker base URL | `http://127.0.0.1:8787` |
| `FIFO_ACCESS_CLIENT_ID` (or `CF_ACCESS_CLIENT_ID`) | Sent as `CF-Access-Client-Id` | — |
| `FIFO_ACCESS_CLIENT_SECRET` (or `CF_ACCESS_CLIENT_SECRET`) | Sent as `CF-Access-Client-Secret` | — |
| `FIFO_BEARER` | Sent as `Authorization: Bearer …` | — |
| `FIFO_ACTOR` | Sent as `X-Fifo-Actor` | — |
| `FIFO_SPOOL` | Write-ahead spool directory | `~/.fifo-spool` |

```text
fifo enqueue --personal <agent> --title <text>
fifo enqueue --team eng|parked --title <text> [--kind code_review|implement|ops]
fifo next --team eng --assignee <ic>
fifo claim-cr --team eng --assignee <ic>
fifo progress --id <id> [--note]
fifo done --id <id>
fifo block --id <id> [--reason]
fifo unblock --id <id>
fifo cancel --id <id>
fifo move --id <id> --team parked|eng
fifo queue show --team eng|parked | --personal <agent>
fifo share mint --queue team:eng|team:parked|personal:<agent>
fifo help
```

`--json` prints the raw response. Mutations need `Idempotency-Key` (the CLI generates one). The CLI never prints secrets. Mutations are written to the spool directory first and deleted only after HTTP 2xx. Replays reuse the original `Idempotency-Key`.

## HTTP API

`GET /health` is public. Everything under `/v1/*` requires auth. Mutations require `Idempotency-Key`. Items are idempotent on `(source_system, source_ref)`. `queue_key` is `personal:<agent>`, `team:eng`, or `team:parked`.

| Method | Path |
|---|---|
| GET | `/health` |
| GET | `/v1/health` |
| POST | `/v1/items` |
| GET | `/v1/items/:id` |
| GET | `/v1/queues/:queue_key` |
| POST | `/v1/queues/:queue_key/claim-next` |
| POST | `/v1/queues/:queue_key/claim-cr` |
| POST | `/v1/queues/:queue_key/sync-in-progress` |
| POST | `/v1/items/:id/progress` |
| POST | `/v1/items/:id/comments` |
| POST | `/v1/items/:id/done` |
| POST | `/v1/items/:id/hard-block` |
| POST | `/v1/items/:id/clear-block` |
| POST | `/v1/items/:id/cancel` |
| POST | `/v1/items/:id/move` |
| POST | `/v1/items/:id/update` |
| POST | `/v1/items/:id/reorder` |
| POST | `/v1/share-tokens` |
| DELETE | `/v1/share-tokens/:token_id` |
| POST | `/v1/queues/:queue_key/rotate-share-generation` |
| GET | `/s/<token>` |

## Cron

`*/5 * * * *` — stall sweep, weekday `eng.hours.open` ping, webhook outbox retry.

## Configuration

These names match live `wrangler.toml`. Do not add extras.

### `[vars]` (committed)

| Var | Default | Purpose |
|---|---|---|
| `AUTH_REQUIRED` | `true` | Require Access JWT, service-token pair, or hashed bearer. Set `false` only in `.dev.vars` for localhost. |
| `CF_ACCESS_TEAM_DOMAIN` | placeholder | Access team domain (`https://<team>.cloudflareaccess.com`) — JWT issuer / JWKS |
| `FIFO_API_HOST` | placeholder | Hostname that serves `/v1/*` |
| `FIFO_SHARE_HOST` | placeholder | Hostname that serves `/s/*` |
| `SHARE_PUBLIC_ORIGIN` | placeholder | Public base URL for minted share links |
| `STALL_TZ` | `America/Denver` | Stall-clock timezone |
| `STALL_START_HOUR` | `8` | Stall window start (wall-clock hour) |
| `STALL_END_HOUR` | `17` | Stall window end (wall-clock hour, exclusive) |
| `STALL_BUSINESS_MINUTES` | `60` | Business minutes of silence before `item.stalled` |
| `ENG_CAPACITY` | `6` | `team:eng` Factory in-progress capacity |

### Secrets (`wrangler secret put` — never git)

| Secret | Purpose |
|---|---|
| `WEBHOOK_HMAC_SECRET` | HMAC key for `Fifo-Signature` |
| `WEBHOOK_DISPATCH_URL` | FIFO Ops routine Webhook URL (empty = stub) |
| `WEBHOOK_DISPATCH_AUTHORIZATION` | `Authorization` header sent with each webhook |
| `CF_ACCESS_AUD` | Access application audience |

Client secrets are not Wrangler config. Store only SHA-256 hex in `api_clients.secret_hash`.

## Layout

| Path | Role |
|---|---|
| `src/` | TypeScript Worker (`/v1/*`, `/s/<token>`, cron `*/5`) |
| `migrations/` | D1 migrations (schema + seed) |
| `schema.sql` | Read-only schema copy |
| `cli/fifo.mjs` | `fifo` CLI (spool + replay) |
| `test/` | FIFO invariants |
| `wrangler.toml` | Worker name, D1 binding, `[vars]`, cron |

## License

This project is MIT-licensed. See [LICENSE](./LICENSE).
