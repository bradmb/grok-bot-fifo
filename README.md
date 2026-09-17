# FIFO Worker

Cloudflare Worker + D1 queue authority + `fifo` CLI. Phase 0 implements queue
creation, personal/team FIFO enqueue, claims, stalls, share boards, and a
webhook outbox. No secrets in git.

## What it does

- `personal:<agent>` queues with one in-progress plate per owner (WIP = 1);
  overflow stays queued with a share link.
- `team:eng` queue with N named IC slots (`queue_slots`). `claim-next` fills
  Factory seats (host `e2b`) from queued implement/ops work in `fifo_seq`
  order. `claim-cr` fills the parallel Code Review lane (Cursor cloud VMs)
  from queued `code_review` work; one CR seat per IC.
- `team:parked` hold lane: capacity 0, not claimable; items are moved
  (not cancelled) between eng and parked.
- Hard-block keeps an in-progress slot held; `clear-block` unblocks without
  releasing the seat. Reorder bumps a queued item within its queue.
- Stall clock: business-hours (default 08:00-17:00 America/Denver, 60 min)
  per in-progress Factory item; CR has no Factory stall clock.
- Session links: `ca_ref` (Cursor cloud agent, `bc-…` → cursor.com/agents)
  and `factory_ref`, set/cleared via update/progress without releasing a seat.
- Share boards: `GET /s/<token>` renders Queued | In Progress | Code Review,
  no TTL, no secrets, 15s live refresh.
- Webhook outbox (CloudEvents envelope, HMAC-signed) with immediate delivery
  attempt and cron retry; empty URL stubs delivery.

## Layout

| Path | Role |
|---|---|
| `src/` | TypeScript Worker (`/v1/*`, `/s/<token>`, cron `*/5`) |
| `migrations/` | D1 migrations (schema + seed) |
| `schema.sql` | Read-only copy of the D1 schema |
| `cli/fifo.mjs` | `fifo` CLI (spool + replay, never prints secrets) |
| `test/` | FIFO invariants (personal WIP, Eng cap, hard-block, CR lane, share, reorder) |

## Prerequisites

- Node 22+ and npm
- A Cloudflare account; the Worker needs a D1 database
- `wrangler` is in devDependencies (`npx wrangler ...`)

## Local

```bash
npm ci
npm test
npm run typecheck
npx wrangler dev
```

Apply migrations to a local D1:

```bash
npx wrangler d1 migrations apply fifo-worker --local
```

`wrangler.toml` defaults to `AUTH_REQUIRED=true` (production shape). For local
dev, set `AUTH_REQUIRED=false` in `.dev.vars` (gitignored) so a seeded
`api_clients` row can bind over localhost. Do not commit `.dev.vars`.

Smoke test against `wrangler dev`:

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true,"service":"fifo-worker"}

curl -s http://127.0.0.1:8787/v1/queues/personal:dev1 \
  -H 'CF-Access-Client-Id: dev-dev1' \
  -H 'X-Fifo-Actor: dev1'
# queued: [], in_progress: []

curl -s http://127.0.0.1:8787/v1/items \
  -H 'CF-Access-Client-Id: dev-dev1' \
  -H 'X-Fifo-Actor: dev1' \
  -H 'Idempotency-Key: smoke-1' \
  -H 'Content-Type: application/json' \
  -d '{"personal":"dev1","title":"Smoke"}'
```

## Deploy (Cloudflare)

1. **Create the D1 database** and copy the returned id:

   ```bash
   npx wrangler d1 create fifo-worker
   ```

2. Put the real `database_id` into `wrangler.toml` under `[[d1_databases]]`.
   Do not invent a UUID.

3. **Apply migrations remotely:**

   ```bash
   npx wrangler d1 migrations apply fifo-worker --remote
   ```

4. **Deploy the Worker:**

   ```bash
   npx wrangler deploy
   ```

   (CI runs tests/typecheck only; there is no auto-deploy from CI.)

5. **Set secrets** (never commit them):

   ```bash
   npx wrangler secret put WEBHOOK_HMAC_SECRET
   npx wrangler secret put WEBHOOK_DISPATCH_URL     # or leave unset to stub
   npx wrangler secret put WEBHOOK_DISPATCH_AUTHORIZATION
   npx wrangler secret put CF_ACCESS_AUD            # if using Access on the API host
   ```

### Client credentials

API clients live in the `api_clients` table and authenticate with either a
Cloudflare Access service token (`CF-Access-Client-Id` / `CF-Access-Client-Secret`)
or a per-client bearer whose SHA-256 is stored in `secret_hash`. Create a client
with `wrangler d1 execute` (hash the secret locally; never paste it into git):

```sql
INSERT INTO api_clients (id, client_id, secret_hash, agent_id, permissions_json, name, created_at)
VALUES (
  lower(hex(randomblob(16))),
  '<access-client-id>',
  '<sha256-hex of the secret>',
  'dispatcher',
  '["dispatcher"]',
  'Dispatcher client',
  datetime('now')
);
```

Permissions: `dispatcher` (claim/cancel/move/sync/team share), `runner`
(move eng↔parked, progress), `team:eng:enqueue`, `team:parked:enqueue`,
`team:eng:progress`, `personal:own`.

### Hosts (optional)

`workers_dev` is fine for a first deploy. For custom hosts with Cloudflare
Access, uncomment the `routes` in `wrangler.toml`, point
`fifo-api.<your-domain>` at the Worker behind Access service tokens, and
`fifo-share.<your-domain>` at the same Worker with no Access (the token in
`/s/<token>` is the bearer). Set `workers_dev = false` once Access is live.

Default vars in `wrangler.toml` mirror this split
(`FIFO_API_HOST`, `FIFO_SHARE_HOST`, `SHARE_PUBLIC_ORIGIN`); replace the
example hostnames with your own.

## API (`/v1/*`)

| Method | Path |
|---|---|
| POST | `/v1/items` (enqueue on `personal:<agent>` / `team:eng` / `team:parked`) |
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

`queue_key` is `personal:<agent>`, `team:eng`, or `team:parked`. Every mutation
requires `Idempotency-Key`. Items are idempotent on `(source_system,
source_ref)`. `kind` is `code_review | implement | ops` (default `implement`);
a legacy `*-cr-rN` `source_ref` or a title containing `CR cycle` routes as
`code_review` for backfill.

## CLI `fifo`

```bash
export FIFO_API=http://127.0.0.1:8787
export FIFO_ACCESS_CLIENT_ID=dev-dev1   # or CF_ACCESS_CLIENT_ID
export FIFO_ACTOR=dev1
export FIFO_SPOOL=/tmp/fifo-spool       # optional; default ~/.fifo-spool

node cli/fifo.mjs enqueue --personal dev1 --title "From box" --json
node cli/fifo.mjs enqueue --team eng --title "Eng job"
node cli/fifo.mjs enqueue --team eng --kind code_review --title "CR"
node cli/fifo.mjs next --team eng --assignee ic1
node cli/fifo.mjs claim-cr --team eng --assignee ic1
node cli/fifo.mjs sync-in-progress --team eng --from-inflight.json ./inflight.json
node cli/fifo.mjs update --id <id> --title "…" --body "…"
node cli/fifo.mjs move --id <id> --team parked
node cli/fifo.mjs reorder --id <id> --to head
node cli/fifo.mjs progress --id <id> --note "moving"
node cli/fifo.mjs done --id <id>
node cli/fifo.mjs block --id <id> --reason "waiting"
node cli/fifo.mjs unblock --id <id>
node cli/fifo.mjs cancel --id <id>
node cli/fifo.mjs share mint --queue personal:dev1
node cli/fifo.mjs queue show --personal dev1
node cli/fifo.mjs queue show --team parked
```

Mutations are written to the spool dir first and deleted only after an HTTP 2xx.
The CLI never prints Access secrets or bearers.

## Cron

`*/5 * * * *` — stall sweep + `eng.hours.open` (once per weekday at 06:00 in
the business-hours timezone) + webhook outbox retry. After-hours (weekdays
06:00-17:00 in the configured timezone; weekends dark) claimable events do not
wake the dispatcher or personal owners; `eng.hours.open` stays exempt so the
Monday-morning drain still fires.

## Configuration (vars)

| Var | Default | Purpose |
|---|---|---|
| `AUTH_REQUIRED` | `true` | require Access/bearer auth |
| `CF_ACCESS_TEAM_DOMAIN` | — | Access team domain for JWT verification |
| `FIFO_API_HOST` / `FIFO_SHARE_HOST` | — | host split for `/v1/*` vs `/s/*` |
| `SHARE_PUBLIC_ORIGIN` | — | public base URL for share links |
| `STALL_TZ` | `America/Denver` | stall clock timezone |
| `STALL_START_HOUR` / `STALL_END_HOUR` / `STALL_BUSINESS_MINUTES` | `8` / `17` / `60` | stall window |
| `ENG_CAPACITY` | `6` | team:eng in-progress capacity |
| `WEBHOOK_HMAC_SECRET` / `WEBHOOK_DISPATCH_URL` / `WEBHOOK_DISPATCH_AUTHORIZATION` | secrets | outbox delivery (URL empty = stub) |
| `CF_ACCESS_AUD` | secret | Access application aud for the API host |

## Out of scope

- Live deploy orchestration (D1 creation, custom host DNS, Access apps must be
  done by someone with Cloudflare access; nothing here mints secrets).
- Chat integrations (events go to the dispatcher webhook only).

## License

UNLICENSED (private repository).
