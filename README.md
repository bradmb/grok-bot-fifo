# grok-bot-fifo

A shared **first-in, first-out work queue for a fleet of Grok Bot agents**.

It runs as a single Cloudflare Worker backed by a D1 (SQLite) database. Agents
push work onto queues, a dispatcher hands the head of the queue to whichever
engineer seat is free, the Worker watches for stalls, and every meaningful
change is POSTed as a signed webhook to a Grok Bot routine so the bot can react.
A small `fifo` command-line tool wraps the HTTP API so agents never have to
hand-craft requests.

The Worker itself never talks in chat. It is the **source of truth for who is
working on what**; the Grok Bot you connect to it does the talking.

---

## Table of contents

1. [How it works](#how-it-works)
2. [Try it locally in five minutes](#try-it-locally-in-five-minutes)
3. [Deploy to Cloudflare](#deploy-to-cloudflare)
4. [Set up your team (agents, seats, capacity)](#set-up-your-team-agents-seats-capacity)
5. [Connect a Grok Bot (webhooks)](#connect-a-grok-bot-webhooks)
6. [Lock it down for production (custom hosts + Cloudflare Access)](#lock-it-down-for-production-custom-hosts--cloudflare-access)
7. [Using the `fifo` CLI](#using-the-fifo-cli)
8. [HTTP API reference](#http-api-reference)
9. [Configuration reference](#configuration-reference)
10. [Scheduled work (cron)](#scheduled-work-cron)
11. [Operations and troubleshooting](#operations-and-troubleshooting)
12. [Development](#development)
13. [License](#license)

---

## How it works

```
 agents / dispatcher bot                     Cloudflare
 ┌──────────────────┐  HTTPS + auth  ┌───────────────────────────┐
 │  fifo CLI        │ ─────────────▶ │  fifo-worker (Worker)     │
 │  (or raw curl)   │ ◀───────────── │   • /v1/* JSON API        │
 └──────────────────┘                │   • /s/<token> share board│
                                     │   • cron every 5 minutes  │
 ┌──────────────────┐  signed POST   │            │              │
 │  Grok Bot        │ ◀───────────── │            ▼              │
 │  webhook routine │                │  D1 database (SQLite)     │
 └──────────────────┘                └───────────────────────────┘
```

### The pieces

| Piece | What it is | Where it lives |
|---|---|---|
| **Worker** | The HTTP API, the share board renderer, and the cron job. | `src/` |
| **D1 database** | Queues, items, seats, API clients, audit log, webhook outbox. | `migrations/` (schema), `src/db.ts` |
| **`fifo` CLI** | A zero-dependency Node script that calls the API for you. | `cli/fifo.mjs` |
| **Grok Bot routine** | *Not in this repo.* A webhook routine you create in Grok Bot that receives events from the Worker and wakes the dispatcher agent. | Your Grok Bot workspace |

### Queues

Every item lives on exactly one queue:

| Queue key | Purpose | Who can claim |
|---|---|---|
| `team:eng` | The engineering team FIFO. Has a fixed number of named **IC seats** (`ic1` … `ic6` out of the box). | The dispatcher, via `claim-next` / `claim-cr` |
| `team:parked` | A holding lane for work that is deliberately on hold. Capacity is zero, so nothing can ever be claimed from it. Move items in and out with `move`. | Nobody |
| `personal:<agent>` | One private queue per agent (for example `personal:dev1`). One item is in progress at a time; finishing it automatically promotes the next. | The owner |

### Two lanes on the Eng queue

Items on `team:eng` have a **kind**: `implement`, `ops`, or `code_review`.

* `implement` / `ops` work is claimed with **`claim-next`** and occupies one of
  the Eng **Factory seats**. The number of Factory seats is `ENG_CAPACITY`
  (default 6). The Worker reports these items with `runtime: "factory"` and
  `host: "e2b"`.
* `code_review` work is claimed with **`claim-cr`** and goes into the parallel
  **Code Review lane**. Each IC has one CR seat, and CR work does **not** use
  Factory capacity, so a review can run alongside an implementation on the same
  IC. The Worker reports these with `runtime: "cursor_cloud_agent"` and
  `host: "cursor_cloud_vm"`.

An item is treated as Code Review if its `kind` is `code_review`, or (for
older callers) if its `source_ref` ends in `-cr-r<N>` or its title contains
"CR cycle".

### Item lifecycle

```
enqueue ──▶ queued ──▶ in_progress  (Factory seat)  ──▶ done
                  └──▶ code_review  (CR seat)       ──▶ done
   any non-terminal state ──▶ cancelled (dispatcher only)
```

* **Hard block** (`block`) flags an in-progress item as blocked so the
  dispatcher and the share board can see it, but **keeps the seat occupied**
  and the stall clock running. Only `done`, `cancel` or `move` frees a seat.
* **Stall clock**: a Factory item that gets no `progress` for a configurable
  number of *business minutes* (default 60 minutes inside 08:00–17:00
  America/Denver, weekdays) is marked stalled and the dispatcher is told.
  Code Review items are not stall-chased.
* **Personal queues auto-start**: enqueuing onto `personal:<agent>` puts the
  item straight into `in_progress` if the owner has nothing running;
  otherwise it waits and the response says `plate_full: true`.
* **Idempotent enqueue**: enqueuing with the same `(source_system, source_ref)`
  twice returns the existing item (HTTP 200, `idempotent: true`) instead of
  creating a duplicate.

### Who is who

The seed data creates these agents. They are just rows in the `agents` table
and you can rename or add to them (see [Set up your team](#set-up-your-team-agents-seats-capacity)).

| Agent | Role |
|---|---|
| `dispatcher` | The bot that owns `team:eng`: claims items for ICs, cancels, moves, reorders, can act as any other agent. |
| `runner` | A helper that may move/reorder items and update any item, but cannot claim. |
| `operator` | A human account. Never used as a webhook destination, even as a `requester_ref`. |
| `dev1` | Example owner of a personal queue. |
| `ic1` … `ic6` | The six Eng seats. |

---

## Try it locally in five minutes

No Cloudflare account is needed for this. You only need **Node.js 22+** and
npm.

```bash
git clone https://github.com/bradmb/grok-bot-fifo.git
cd grok-bot-fifo
npm ci
npm test            # 100+ unit tests against an in-memory D1 stub
```

1. Create the local database and apply every migration. Wrangler keeps the
   SQLite file under `.wrangler/` (gitignored). A real `database_id` is not
   required for `--local`.

   ```bash
   npm run d1:local
   ```

2. Turn off authentication for localhost and register a dev client. With
   `AUTH_REQUIRED=false` the Worker accepts requests from `localhost` /
   `127.0.0.1` that name a seeded client in the `CF-Access-Client-Id` header
   (no secret needed).

   ```bash
   printf 'AUTH_REQUIRED=false\n' > .dev.vars      # gitignored

   npx wrangler d1 execute fifo-worker --local --command \
     "INSERT OR IGNORE INTO api_clients (id, client_id, secret_hash, agent_id, permissions_json, name, created_at)
      VALUES ('local-dispatcher', 'dev-dispatcher', '', 'dispatcher', '[\"dispatcher\"]', 'Local dispatcher', datetime('now'))"
   ```

3. Start the dev server (defaults to `http://127.0.0.1:8787`):

   ```bash
   npm run dev
   ```

4. In another terminal, point the CLI at it and run a full cycle:

   ```bash
   export FIFO_API=http://127.0.0.1:8787
   export FIFO_ACCESS_CLIENT_ID=dev-dispatcher     # matches the row you inserted

   curl -s $FIFO_API/health                          # {"ok":true,"service":"fifo-worker"}

   node ./cli/fifo.mjs enqueue --team eng --title "Smoke test" --source-ref smoke-1
   node ./cli/fifo.mjs queue show --team eng
   node ./cli/fifo.mjs next --team eng --assignee ic1
   node ./cli/fifo.mjs progress --id <item-id> --note "working"
   node ./cli/fifo.mjs done --id <item-id>
   ```

   `enqueue` prints a share-board URL followed by `queued <id> <title>`. Open
   the URL in a browser to see the public board.

> **Gotcha:** the CLI also reads `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`
> from your environment. If a secret is set (for example from another
> Cloudflare project) the Worker will try to validate the pair as a real
> service token and you will see `Unknown Access service token`. `unset
> CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET` first.

Webhooks are not delivered locally unless you set `WEBHOOK_DISPATCH_URL` in
`.dev.vars`; without it, events are written to the `webhook_outbox` table and
marked `stubbed`.

---

## Deploy to Cloudflare

### Prerequisites

* A Cloudflare account with **Workers** and **D1** enabled (the free plan works
  for evaluation).
* Node.js 22+ and npm on the machine you deploy from.
* For production: a domain on Cloudflare and **Cloudflare Zero Trust (Access)**
  — see [Lock it down](#lock-it-down-for-production-custom-hosts--cloudflare-access).
  You can skip this for a first deploy.

### Step 1 — Log in to Cloudflare

```bash
npx wrangler login
npx wrangler whoami     # prints your account id
```

If you have more than one account, uncomment `account_id` in `wrangler.toml`
and paste the id from `whoami`.

### Step 2 — Create the D1 database

```bash
npx wrangler d1 create fifo-worker
```

The command prints a `database_id`. Open `wrangler.toml`, uncomment the
`database_id` line in the `[[d1_databases]]` block and paste it in:

```toml
[[d1_databases]]
binding = "DB"
database_name = "fifo-worker"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   # from `wrangler d1 create`
migrations_dir = "migrations"
```

Never invent this value — Cloudflare issues it.

### Step 3 — Apply the migrations

```bash
npx wrangler d1 migrations apply fifo-worker --remote
```

This creates every table and seeds the agents, the `team:eng` queue with six
seats, the `team:parked` lane and one personal queue per agent. Run the same
command again whenever you pull a new migration from this repo; Wrangler only
applies the ones that have not run yet.

> The Worker also bootstraps an empty database automatically on its first
> request, but the migration path is the one that is tracked, so use it.

### Step 4 — Fill in `[vars]` in `wrangler.toml`

For a first deploy you only need to check these (the rest can stay as-is):

| Var | Set it to |
|---|---|
| `AUTH_REQUIRED` | Leave `"true"`. |
| `CF_ACCESS_TEAM_DOMAIN` | Your Zero Trust team domain, e.g. `https://acme.cloudflareaccess.com`. Only used for Access JWT verification; harmless if you are not using Access yet. |
| `FIFO_API_HOST` / `FIFO_SHARE_HOST` / `SHARE_PUBLIC_ORIGIN` | Leave the placeholders for now. They only take effect once you add custom domains ([Lock it down](#lock-it-down-for-production-custom-hosts--cloudflare-access)). |
| `STALL_*`, `ENG_CAPACITY` | Adjust if your business hours or seat count differ. See [Configuration reference](#configuration-reference). |

### Step 5 — Deploy

```bash
npm run deploy      # = wrangler deploy
```

Wrangler prints the URL, something like
`https://fifo-worker.<your-subdomain>.workers.dev`. Check it:

```bash
curl -s https://fifo-worker.<your-subdomain>.workers.dev/health
# {"ok":true,"service":"fifo-worker"}
```

Everything under `/v1/` will return `401` until you create an API client.

### Step 6 — Set the secrets

Secrets are stored with `wrangler secret put`, never in git.

```bash
npx wrangler secret put WEBHOOK_HMAC_SECRET            # any long random string
npx wrangler secret put WEBHOOK_DISPATCH_URL           # Grok Bot webhook URL (can be set later)
npx wrangler secret put WEBHOOK_DISPATCH_AUTHORIZATION # e.g. "Bearer <token>" (optional)
npx wrangler secret put CF_ACCESS_AUD                  # only once you use Cloudflare Access
```

You can leave `WEBHOOK_DISPATCH_URL` empty for now; the Worker will stub
deliveries until it is set. Generate a good HMAC secret with
`openssl rand -hex 32`.

### Step 7 — Create the dispatcher API client

Every caller is a row in the `api_clients` table. A row has a `client_id`, a
`secret_hash` (the **SHA-256 of the secret — never the secret itself**), the
`agent_id` it acts as, and a list of permissions.

Two ways to authenticate exist; the simplest to start with is a **bearer
token**:

```bash
# 1. Generate a secret and keep it somewhere safe (a vault, not a file in this repo).
CLIENT_SECRET="$(openssl rand -hex 32)"
echo "$CLIENT_SECRET"

# 2. Hash it.
SECRET_HASH="$(printf '%s' "$CLIENT_SECRET" | openssl dgst -sha256 | awk '{print $NF}')"

# 3. Insert the client row with the hash only.
npx wrangler d1 execute fifo-worker --remote --command \
  "INSERT INTO api_clients (id, client_id, secret_hash, agent_id, permissions_json, name, created_at)
   VALUES (lower(hex(randomblob(16))), 'dispatcher-bot', '$SECRET_HASH', 'dispatcher', '[\"dispatcher\"]', 'Dispatcher Grok Bot', datetime('now'))"
```

The Worker hashes the incoming `Authorization: Bearer <secret>` and looks up
the row by hash, so `client_id` is just a label for bearer clients.

If you use **Cloudflare Access service tokens** instead, `client_id` must equal
the service token's Client ID and `secret_hash` is the SHA-256 of its Client
Secret. Access JWTs (a human behind an Access login) are matched to
`client_id` by the token's `common_name`, `email`, `preferred_username` or
`sub` claim, lower-cased.

#### Permissions

`permissions_json` is a JSON array of strings:

| Permission | Grants |
|---|---|
| `dispatcher` | Everything: enqueue anywhere, `claim-next`, `claim-cr`, `sync-in-progress`, `cancel`, `move`, `reorder`, share administration on all queues, and acting as another agent via the `X-Fifo-Actor` header. |
| `runner` | `move`, `reorder`, and progress/comment/done/block/update on any item. Cannot claim or cancel. |
| `team:eng:enqueue` | Enqueue onto `team:eng` and `team:parked`. |
| `team:parked:enqueue` | Enqueue onto `team:parked` only. |
| `team:eng:progress` | Progress/comment/done/block/update any item even when not the assignee (intended for Eng helpers). |
| `personal:own` | Placeholder for personal-queue owners. Ownership itself is decided by `agent_id`: a client whose `agent_id` owns a personal queue can always enqueue, mutate and mint shares on it. |

An IC that only needs to report on its own work needs **no** permission — the
assignee of an item can always `progress`, `done`, `block` and `comment` on it.

### Step 8 — Smoke test the deployment

```bash
export FIFO_API=https://fifo-worker.<your-subdomain>.workers.dev
export FIFO_BEARER="$CLIENT_SECRET"

curl -s -H "Authorization: Bearer $FIFO_BEARER" $FIFO_API/v1/health
# {"ok":true,"service":"fifo-worker","actor":"Dispatcher Grok Bot"}

npm link                      # makes `fifo` available on your PATH (or use node ./cli/fifo.mjs)
fifo queue show --team eng
fifo enqueue --team eng --title "Deploy smoke test" --source-ref deploy-smoke-1
fifo next --team eng --assignee ic1
fifo done --id <item-id>
```

You now have a working queue. Next: [set up your team](#set-up-your-team-agents-seats-capacity)
and [connect the bot](#connect-a-grok-bot-webhooks).

---

## Set up your team (agents, seats, capacity)

The seed gives you placeholder names (`ic1`, `Dev 1`, …). Everything is plain
SQL in D1; run statements with `npx wrangler d1 execute fifo-worker --remote
--command "…"` (drop `--remote` for the local database).

**Rename an IC** — `key` is what agents pass as `--assignee` (keep it
lowercase; the Worker lowercases input), `display_name` shows on share boards.
The row `id` stays put and is what appears as `assignee` in API responses and
webhooks:

```sql
UPDATE agents SET key = 'alice', display_name = 'Alice' WHERE id = 'ic1';
UPDATE queue_slots SET label = 'alice' WHERE id = 'eng:ic1';
```

**Add a seventh IC seat** — an agent row, a personal queue, an Eng seat, and
bump the Factory capacity to match:

```sql
INSERT INTO agents (id, key, display_name, quiet, created_at)
  VALUES ('ic7', 'ic7', 'IC 7', 0, datetime('now'));
INSERT INTO queues (id, queue_key, kind, owner_agent_id, title, capacity, created_at)
  VALUES ('personal:ic7', 'personal:ic7', 'personal', 'ic7', 'IC 7 personal', 1, datetime('now'));
INSERT INTO queue_slots (id, queue_id, agent_id, label, status, created_at)
  VALUES ('eng:ic7', 'team:eng', 'ic7', 'ic7', 'enabled', datetime('now'));
UPDATE queues SET capacity = 7 WHERE queue_key = 'team:eng';
```

Then set `ENG_CAPACITY = "7"` in `wrangler.toml` and redeploy. `ENG_CAPACITY`
is what the Worker actually enforces for Factory seats; the `capacity` column
is informational. The Code Review lane has one seat per **enabled** slot
automatically. (`migrations/0004_eng_extra_seats.sql` is the same recipe as a
migration, which is the better option if you want the change tracked in git.)

**Take a seat out of rotation** without deleting history:

```sql
UPDATE queue_slots SET status = 'disabled' WHERE id = 'eng:ic6';   -- or 'draining'
```

Only `enabled` slots can be claimed into. Disabled slots do not reduce
`ENG_CAPACITY`, so lower that too if you want fewer parallel Factory items.

**Give a personal queue to someone new** — the pattern is the same as the
`agents` + `queues` inserts above, minus the `queue_slots` row.

**Add more API clients** — one row per bot or human, following Step 7. Use the
smallest permission set that works (for example `["team:eng:enqueue"]` for a
ticket-intake bot).

---

## Connect a Grok Bot (webhooks)

The Worker does not know anything about chat. When something the dispatcher
should react to happens, it writes an event into the `webhook_outbox` table
and POSTs it to `WEBHOOK_DISPATCH_URL`. The receiving end is a **Grok Bot
webhook routine** that you create; the routine's job is to wake the dispatcher
agent and let it decide what to do (usually: run `fifo next` if a seat is free,
or chase a stalled assignee).

### 1. Create the routine in Grok Bot

Create a routine of type **webhook**. Grok Bot gives you:

* a **webhook URL**, and
* usually a **bearer token** (or similar) that callers must present.

### 2. Tell the Worker where to send events

```bash
npx wrangler secret put WEBHOOK_DISPATCH_URL             # the routine's URL
npx wrangler secret put WEBHOOK_DISPATCH_AUTHORIZATION   # the full header value, e.g. "Bearer abc123"
npx wrangler secret put WEBHOOK_HMAC_SECRET              # shared key; the routine uses it to verify signatures
```

No redeploy is needed after changing secrets. If `WEBHOOK_HMAC_SECRET` is not
set, the Worker signs with an empty key — set it.

### 3. What the routine receives

Each delivery is one HTTP `POST` with a **CloudEvents 1.0** JSON body:

```
POST <WEBHOOK_DISPATCH_URL>
Content-Type: application/json
Authorization: <WEBHOOK_DISPATCH_AUTHORIZATION>          (only if set)
Fifo-Event-Id: 8f2c…                                     (unique per event)
Fifo-Timestamp: 2026-09-17T15:04:05.000Z
Fifo-Signature: sha256=<hex>
```

```json
{
  "specversion": "1.0",
  "id": "8f2c…",
  "source": "fifo-worker",
  "type": "item.enqueued",
  "time": "2026-09-17T15:04:05.000Z",
  "datacontenttype": "application/json",
  "data": {
    "queue_key": "team:eng",
    "item_id": "f5ba5430-…",
    "title": "Fix login redirect",
    "assignee": null,
    "kind": "implement",
    "state": "queued"
  }
}
```

For item events `data` contains `queue_key`, `item_id`, `title`, `assignee`,
`kind` and `state`, plus event-specific extras. `item.stalled` carries
`queue_key`, `item_id`, `title` and `stall_generation`; `eng.hours.open`
carries `queue_key`, `opened_at`, `hours_date`, `hours` and a `hint`.

### 4. Verify the signature in the routine

The signature is HMAC-SHA256, hex encoded, over the string
`"<Fifo-Timestamp>.<Fifo-Event-Id>.<raw request body>"`, using
`WEBHOOK_HMAC_SECRET` as the key. Compare it to the `Fifo-Signature` header
after stripping the `sha256=` prefix, and reject anything that does not match.
Use `Fifo-Event-Id` to ignore duplicates — retries reuse the same id.

Node.js reference:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(headers, rawBody, secret) {
  const expected = createHmac("sha256", secret)
    .update(`${headers["fifo-timestamp"]}.${headers["fifo-event-id"]}.${rawBody}`)
    .digest("hex");
  const got = (headers["fifo-signature"] || "").replace(/^sha256=/, "");
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
```

### 5. Event types and what the dispatcher should do

| Event | Fires when | Suggested reaction |
|---|---|---|
| `item.enqueued` | New item on `team:eng` | If a Factory seat is free: `fifo next --team eng --assignee <ic>`. If it is Code Review: `fifo claim-cr`. |
| `item.assigned` | An item on `team:eng` was claimed into a seat | Tell the IC to start. |
| `item.stalled` | A Factory item (Eng or personal) passed the stall clock without progress | Chase the assignee. `stall_generation` increments each time. |
| `item.hard_blocked` / `item.hard_block_cleared` | `block` / `unblock` on `team:eng` | Note that the seat is still held. |
| `item.done` | An item with a `requester_ref` (other than `operator`) completed | Tell the requester; claim the next item if a seat opened. |
| `eng.hours.open` | 06:00 America/Denver, weekdays | Drain whatever queued up overnight. |
| `item.cancelled`, `item.moved`, `item.reordered`, `item.progress`, `item.commented`, `item.updated`, `capacity.available`, `capacity.changed` | Housekeeping | Written to the `item_events` audit table but **never** sent to the dispatcher. |

### 6. When the Worker stays quiet on purpose

To keep the bot from being spammed, the Worker **drops** dispatcher wakeups
for:

* anything on `team:parked`;
* items whose title or body contains hold words (`parked`, `hold`, `stop`,
  `do not touch`, `look ≠ go`);
* progress, comment, update, move, reorder and capacity chatter;
* `enqueued`, `assigned`, `stalled` and block events on `team:eng` and personal
  queues **outside weekdays 06:00–17:00 America/Denver** (this window is
  currently hard-coded, independent of `STALL_TZ`). The `eng.hours.open` ping
  at 06:00 is exempt so the morning drain still happens;
* `enqueued` / `assigned` / `stalled` for an item that is already `done` or
  `cancelled`.

Every event is still written to the `item_events` audit table regardless.

Owners of personal queues are also recorded as outbox destinations for
`enqueued` / `assigned` / `stalled` on their own queue, and `requester_ref`
values for `item.done`, but only rows addressed to `dispatcher` are actually
POSTed today; the others are marked `stubbed`.

### 7. Delivery and retries

* The first delivery attempt happens **immediately** when the event is
  created, in the same request.
* Failures (non-2xx or network error) are retried by the cron job with
  exponential backoff: 2, 4, 8, 16 minutes, then every 30 minutes.
* After **10 attempts** the row's status flips from `pending` to `failed`.
  It is still retried every 30 minutes; the status is there so you can find
  chronic failures. Successful rows are `delivered`; rows written while
  `WEBHOOK_DISPATCH_URL` was empty are `stubbed` and never retried.

```sql
SELECT status, COUNT(*) FROM webhook_outbox GROUP BY status;
SELECT id, event_type, attempts, last_error FROM webhook_outbox WHERE status = 'failed';
-- give up on a chronic failure:
UPDATE webhook_outbox SET status = 'stubbed' WHERE id = '<id>';
```

---

## Lock it down for production (custom hosts + Cloudflare Access)

The first deploy serves both the JSON API and the public share boards from
one `*.workers.dev` hostname, protected only by bearer tokens. For production
the intended layout is:

| Host | Serves | Protected by |
|---|---|---|
| `fifo-api.<your-domain>` | `/v1/*` and `/health` | Cloudflare Access (service tokens / SSO) **plus** the Worker's own client check |
| `fifo-share.<your-domain>` | `/s/<token>` share boards only | The unguessable token in the URL |

1. **Add DNS + routes.** In `wrangler.toml`, uncomment the `routes` block and
   put in your two hostnames (Wrangler creates the DNS records for
   `custom_domain = true`).
2. **Set the host vars** so the Worker knows which hostname is which:

   ```toml
   FIFO_API_HOST = "fifo-api.example.com"
   FIFO_SHARE_HOST = "fifo-share.example.com"
   SHARE_PUBLIC_ORIGIN = "https://fifo-share.example.com"
   ```

   Once set, the API host returns `404` for `/s/*` and the share host returns
   `404` for `/v1/*`. Share URLs minted through the API host will point at
   `SHARE_PUBLIC_ORIGIN`.
3. **Create a Zero Trust Access application** for `fifo-api.<your-domain>`.
   Add a policy that allows your service tokens (and any humans). Copy the
   application's **Audience (AUD) tag** and set it:

   ```bash
   npx wrangler secret put CF_ACCESS_AUD
   ```

   and make sure `CF_ACCESS_TEAM_DOMAIN` in `[vars]` is your
   `https://<team>.cloudflareaccess.com` domain.
4. **Create a service token** in Zero Trust for the dispatcher bot. Insert an
   `api_clients` row whose `client_id` is the token's Client ID and whose
   `secret_hash` is the SHA-256 of the Client Secret (same hashing as Step 7).
   Configure the bot with `FIFO_ACCESS_CLIENT_ID` / `FIFO_ACCESS_CLIENT_SECRET`
   instead of a bearer.
5. **Disable the workers.dev hostname**: set `workers_dev = false` in
   `wrangler.toml` and redeploy. Otherwise the API stays reachable on
   `*.workers.dev`, bypassing Access.
6. **Redeploy** with `npm run deploy` and re-run the smoke test against the
   new API host.

The Worker checks credentials in this order and uses the first one present:
`Cf-Access-Jwt-Assertion` (Access login) → `CF-Access-Client-Id` +
`CF-Access-Client-Secret` (service token) → `Authorization: Bearer` (hashed
bearer) → localhost dev bypass (only when `AUTH_REQUIRED=false`).

---

## Using the `fifo` CLI

`cli/fifo.mjs` is a single file with no dependencies beyond Node 22.

```bash
npm link            # `fifo` on your PATH, from this checkout
# or: npm i -g .
# or: node ./cli/fifo.mjs …
```

### Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `FIFO_API` | Base URL of the Worker | `http://127.0.0.1:8787` |
| `FIFO_ACCESS_CLIENT_ID` (or `CF_ACCESS_CLIENT_ID`) | Sent as `CF-Access-Client-Id` | — |
| `FIFO_ACCESS_CLIENT_SECRET` (or `CF_ACCESS_CLIENT_SECRET`) | Sent as `CF-Access-Client-Secret` | — |
| `FIFO_BEARER` | Sent as `Authorization: Bearer …` (when not using Access) | — |
| `FIFO_ACTOR` | Sent as `X-Fifo-Actor`. Lets a **dispatcher** client act as another agent (e.g. `ic1` marking its own item done). | — |
| `FIFO_SPOOL` | Directory for the write-ahead spool (see below) | `~/.fifo-spool` |

`FIFO_*` names win over `CF_ACCESS_*` names when both are set.

### Commands

```
fifo enqueue --personal <agent> --title <text> [--body <text>] [--source-ref <ref>]
fifo enqueue --team eng|parked --title <text> [--body] [--source-ref] [--requester <ref>]
             [--kind code_review|implement|ops]
fifo next        --team eng --assignee <ic>          # claim head of queue into a Factory seat
fifo claim-cr    --team eng --assignee <ic>          # claim head of Code Review work into the CR lane
fifo sync-in-progress --team eng --from-inflight.json <file>
fifo update      --id <id> [--title …] [--body …] [--requester …] [--kind …]
                 [--ca-ref <bc-…>] [--factory-ref <ref>]   # bare --ca-ref / --factory-ref clears
fifo move        --id <id> --team parked|eng
fifo reorder     --id <id> --to head|tail | --position N | --before <id> | --after <id>
fifo progress    --id <id> [--note <text>] [--ca-ref <bc-…>] [--factory-ref <ref>]
fifo done        --id <id>
fifo block       --id <id> [--reason <text>]
fifo unblock     --id <id>
fifo cancel      --id <id>
fifo share mint  --queue personal:<agent>|team:eng|team:parked [--focus <item-id>]
fifo share revoke --token-id <id>
fifo queue show  --personal <agent> | --team eng|parked
fifo help
```

Add `--json` to any command to get the raw API response (for scripts).
Secrets are never printed.

### Typical dispatcher loop

```bash
fifo queue show --team eng --json | jq '{capacity, occupancy, code_review_occupancy, queued: (.queued|length)}'
fifo next --team eng --assignee ic2            # 409 NO_CAPACITY if all Factory seats are taken
fifo claim-cr --team eng --assignee ic2        # 409 if ic2 already has a CR item
```

### Typical IC loop

```bash
export FIFO_ACTOR=ic2                          # only works with a dispatcher credential
fifo progress --id "$ITEM" --note "tests green, opening PR" --ca-ref bc-1234abcd
fifo block    --id "$ITEM" --reason "waiting on staging creds"
fifo unblock  --id "$ITEM"
fifo done     --id "$ITEM"
```

`--ca-ref` records a Cursor cloud-agent session id (`bc-…`), `--factory-ref` a
Factory session ref; both are shown as links on the share board.

### Reconciling after a crash: `sync-in-progress`

If the dispatcher restarts and is unsure what is actually running, it can hand
the Worker its list of in-flight jobs and let the Worker fix up the database:

```bash
cat > inflight.json <<'EOF'
{ "in_progress": [
    { "id": "f5ba5430-…", "assignee": "ic1" },
    { "source_ref": "JIRA-123", "assignee": "ic2" }
] }
EOF
fifo sync-in-progress --team eng --from-inflight.json inflight.json
```

Rows are matched by `id` or by `source_ref`. Listed items are forced into
`in_progress` on the named IC's seat; Factory items currently in progress that
are **not** listed are put back to `queued` (keeping their original FIFO
position) so no seat is leaked. The roster may not exceed `ENG_CAPACITY`, and
Code Review items are rejected (`409 CANNOT_SYNC_CODE_REVIEW`).

### Write-ahead spool

Every mutating command is written to `FIFO_SPOOL` **before** it is sent and
deleted after a `2xx`. On the next invocation the CLI first replays anything
left in the spool. Because each spooled request keeps its original
`Idempotency-Key`, a replay of an already-applied mutation is a no-op on the
server.

Two consequences worth knowing:

* If the Worker is unreachable, the command exits non-zero but the request
  is not lost; the next successful `fifo` call delivers it.
* A request spooled with **bad credentials** will keep failing on every replay.
  Delete the offending `.json` file in the spool directory.

---

## HTTP API reference

Base path `/v1`. All bodies and responses are JSON.

### Authentication headers

Pick one:

```
Authorization: Bearer <secret>                   # hashed bearer client
CF-Access-Client-Id: <id>                        # Cloudflare Access service token
CF-Access-Client-Secret: <secret>
Cf-Access-Jwt-Assertion: <jwt>                   # set by Cloudflare Access itself
```

Optional: `X-Fifo-Actor: <agent-key>` — a dispatcher client may act as another
agent. Non-dispatcher clients can only name themselves.

### Idempotency

Every `POST`/`DELETE` under `/v1` **must** include an `Idempotency-Key`
header (any unique string, e.g. a UUID). It is scoped per client:

* same key + same body → the stored response is returned again;
* same key + different body → `409 IDEMPOTENCY_CONFLICT`;
* missing → `400 IDEMPOTENCY_KEY_REQUIRED`.

The CLI generates one automatically.

### Endpoints

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/health` | — | Public. `{"ok":true,"service":"fifo-worker"}` |
| `GET` | `/v1/health` | — | Same, plus `actor`; use it to test credentials. |
| `POST` | `/v1/items` | `title` (required), `team` / `personal` / `queue_key`, `body`, `source_system`, `source_ref`, `requester_ref`, `kind` | Enqueue. `201` with `{ item, position, plate_full, share_url, reply_text }`, or `200` with `{ item, idempotent: true }` when `(source_system, source_ref)` already exists. |
| `GET` | `/v1/items/:id` | — | `{ item }` |
| `GET` | `/v1/queues/:queue_key` | — | Queue snapshot: `capacity`, `occupancy`, `code_review_occupancy`, `code_review_capacity`, `slots[]`, `queued[]`, `in_progress[]`, `code_review[]`. `team/eng` and `team:eng` are both accepted. |
| `POST` | `/v1/queues/:queue_key/claim-next` | `assignee` | Dispatcher only. Head `implement`/`ops` item → the assignee's Factory seat. `409 NO_CAPACITY`, `409 SLOT_UNAVAILABLE`, `404 QUEUE_EMPTY` / `NO_IMPLEMENT_QUEUED`, `409 CLAIM_RACE`. |
| `POST` | `/v1/queues/:queue_key/claim-cr` | `assignee` | Dispatcher only. Head Code Review item → the assignee's CR seat. `409 CR_SEAT_HELD`, `404 NO_CR_QUEUED`. |
| `POST` | `/v1/queues/:queue_key/sync-in-progress` | `in_progress: [{ id \| source_ref, assignee }]` | Dispatcher only. See above. |
| `POST` | `/v1/queues/:queue_key/rotate-share-generation` | — | Invalidates every existing share link for the queue. |
| `POST` | `/v1/items/:id/progress` | `note`, `ca_ref`, `factory_ref` | Resets the stall clock. Does not free the seat. |
| `POST` | `/v1/items/:id/comments` | `body` | Public comment shown on the share board. |
| `POST` | `/v1/items/:id/done` | — | Frees the seat; personal queues auto-promote the next item. |
| `POST` | `/v1/items/:id/hard-block` | `reason` | Seat stays held. |
| `POST` | `/v1/items/:id/clear-block` | — | |
| `POST` | `/v1/items/:id/cancel` | — | Dispatcher only. |
| `POST` | `/v1/items/:id/move` | `team` or `queue_key` | Dispatcher/runner. Destination must be `team:eng` or `team:parked`. Works on queued **and** active items: an in-progress item is unseated and re-queued at the tail of the destination. |
| `POST` | `/v1/items/:id/update` | `title`, `body`, `requester_ref`, `kind`, `ca_ref`, `factory_ref` | Only fields present in the body change; an empty string clears `body`, `requester_ref`, `ca_ref`, `factory_ref` (title cannot be emptied). Changing `kind` to/from `code_review` on a queued item switches lanes. |
| `POST` | `/v1/items/:id/reorder` | one of `to: head\|tail`, `position`, `before`, `after` | Dispatcher/runner. Queued items only. |
| `POST` | `/v1/share-tokens` | `queue_key` (or `team` / `personal`), `focus_item_id` | Mints a share link. Returns `share_url`, `token_id`. |
| `DELETE` | `/v1/share-tokens/:token_id` | — | Revokes one link. |
| `GET` | `/s/<token>` | — | Public HTML board. Never served on the API host once hosts are split. |

### The item object

```json
{
  "id": "f5ba5430-4740-4a10-8204-8d1564553f4c",
  "queue_key": "team:eng",
  "fifo_seq": 1,
  "state": "in_progress",
  "slot_id": "eng:ic1",
  "assignee": "ic1",
  "assignee_name": "IC 1",
  "source_system": "",
  "source_ref": "smoke-1",
  "requester_ref": "",
  "title": "Smoke test",
  "body": "",
  "kind": "implement",
  "code_review": false,
  "runtime": "factory",
  "host": "e2b",
  "cr_slot": null,
  "ca_ref": null,
  "factory_ref": null,
  "position": 1,
  "hard_blocked": false,
  "block_reason": null,
  "enqueued_at": "2026-09-17T18:59:13.710Z",
  "started_at": "2026-09-17T18:59:13.821Z",
  "done_at": null,
  "next_stall_at": "2026-09-17T19:59:00.000Z",
  "stall_generation": 1
}
```

### Errors

Errors are `{ "error": "<CODE>", "message": "…" }`. Codes you will meet most
often:

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Mutation without an `Idempotency-Key`. |
| 400 | `NOT_QUEUED` | Reorder on an item that is not `queued`. |
| 400 | `UNKNOWN_ASSIGNEE` / `NO_SLOT` | `assignee` is not an agent, or has no enabled Eng seat. |
| 401 | `UNAUTHORIZED` | No/invalid credential; `message` says which check failed. |
| 403 | `FORBIDDEN` | Credential is valid but lacks the permission. |
| 404 | `QUEUE_NOT_FOUND` / `ITEM_NOT_FOUND` | |
| 404 | `QUEUE_EMPTY` / `NO_IMPLEMENT_QUEUED` / `NO_CR_QUEUED` | Nothing claimable of that kind. |
| 409 | `NO_CAPACITY` | All Factory seats are occupied. |
| 409 | `SLOT_UNAVAILABLE` / `CR_SEAT_HELD` | That IC already holds a Factory / CR item. |
| 409 | `NOT_IN_PROGRESS` / `NOT_ACTIVE` | Action needs an in-progress (or non-terminal) item. |
| 409 | `CLAIM_RACE` / `REORDER_RACE` / `MOVE_RACE` | Concurrent change; retry. |
| 409 | `IDEMPOTENCY_CONFLICT` | Same `Idempotency-Key`, different body. |
| 422 | `TEAM_QUEUE_REQUIRED` | Code Review work must be on `team:eng` or `team:parked`. |

### Share boards

`share_url` values are bearer credentials: anyone with the link can read the
queue (titles, assignees, public comments, session links). Treat them like
secrets. Revoke a single link with `DELETE /v1/share-tokens/:id`, or rotate the
queue's generation to kill all of them at once. Every `enqueue` mints a fresh
link focused on the new item so it can be handed to the requester.

---

## Configuration reference

### `[vars]` in `wrangler.toml` (committed, non-secret)

| Var | Default | Purpose |
|---|---|---|
| `AUTH_REQUIRED` | `"true"` | Keep `true` in production. `false` only in `.dev.vars` for localhost. |
| `CF_ACCESS_TEAM_DOMAIN` | placeholder | `https://<team>.cloudflareaccess.com`; issuer for Access JWT verification. |
| `FIFO_API_HOST` | placeholder | Hostname that serves `/v1/*` only. Ignored until it matches a real request host. |
| `FIFO_SHARE_HOST` | placeholder | Hostname that serves `/s/*` only. |
| `SHARE_PUBLIC_ORIGIN` | placeholder | Origin used when minting share URLs once hosts are split. |
| `STALL_TZ` | `America/Denver` | Time zone for the stall clock's business hours. (The webhook quiet window and the 06:00 open ping are currently hard-coded to America/Denver.) |
| `STALL_START_HOUR` / `STALL_END_HOUR` | `8` / `17` | Business hours for the stall clock. |
| `STALL_BUSINESS_MINUTES` | `60` | Business minutes without progress before a Factory item is stalled. |
| `ENG_CAPACITY` | `6` | Number of Factory seats on `team:eng`. |

### Secrets (`wrangler secret put <NAME>`)

| Secret | Purpose |
|---|---|
| `WEBHOOK_HMAC_SECRET` | Key for the `Fifo-Signature` HMAC. |
| `WEBHOOK_DISPATCH_URL` | Grok Bot webhook routine URL. Empty → deliveries are stubbed. |
| `WEBHOOK_DISPATCH_AUTHORIZATION` | Full `Authorization` header value sent with each webhook (e.g. `Bearer …`). Optional. |
| `CF_ACCESS_AUD` | Audience tag of the Access application on the API host. Required only for Access JWT logins. |

Client secrets are **not** Worker secrets — only their SHA-256 hashes live in
`api_clients.secret_hash`.

### Local overrides

`.dev.vars` (gitignored) is read by `wrangler dev` and can override any var or
secret, for example:

```
AUTH_REQUIRED=false
WEBHOOK_DISPATCH_URL=https://example.test/hook   # optional: exercise real deliveries locally
WEBHOOK_HMAC_SECRET=dev-secret
```

---

## Scheduled work (cron)

`wrangler.toml` schedules the Worker every five minutes (`*/5 * * * *`). Each
run:

1. **Stall sweep** — items in `in_progress` whose `next_stall_at` has passed
   get `stall_generation + 1`, a new deadline, and an `item.stalled` event.
   Code Review items have no stall clock and are skipped; hard-blocked items
   are **not** skipped.
2. **Eng open ping** — on weekdays, the run that lands between 06:00 and
   06:04 America/Denver emits `eng.hours.open` for `team:eng` (at most once
   per day).
3. **Outbox delivery** — retries pending webhook rows whose backoff has
   elapsed.

You can trigger it by hand while developing:

```bash
npx wrangler dev --test-scheduled
curl 'http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*'
```

---

## Operations and troubleshooting

**Deploying an update**

```bash
git pull
npm ci && npm test
npx wrangler d1 migrations apply fifo-worker --remote   # only applies new files
npm run deploy
```

**Looking at the data**

```bash
npx wrangler d1 execute fifo-worker --remote --command "SELECT id, state, assignee_agent_id, title FROM items WHERE state != 'done' ORDER BY fifo_seq"
npx wrangler d1 execute fifo-worker --remote --command "SELECT event_type, actor_agent_id, created_at FROM item_events ORDER BY created_at DESC LIMIT 20"
npx wrangler tail          # live request/console logs
```

**Common problems**

| Symptom | Cause / fix |
|---|---|
| `401` with `Invalid bearer` | The bearer's SHA-256 does not match any `api_clients.secret_hash`. Re-hash with `printf '%s'` (no trailing newline) and compare. |
| `401` with `Unknown Access service token` | `CF-Access-Client-Id` not found or the row has an empty `secret_hash`. Locally: unset stray `CF_ACCESS_*` env vars. |
| `401` with `Local dev client required` | `AUTH_REQUIRED=false` but no `CF-Access-Client-Id` / `X-Fifo-Client` header naming a seeded client. Set `FIFO_ACCESS_CLIENT_ID`. |
| `403 FORBIDDEN` on `next` / `claim-cr` / `cancel` | Only clients with the `dispatcher` permission may do this. |
| `404` on `/v1/*` after adding custom hosts | You are hitting the share host. API calls must go to `FIFO_API_HOST`. |
| `409 NO_CAPACITY` / `SLOT_UNAVAILABLE` but the board looks empty | A hard-blocked item still holds the seat, or `ENG_CAPACITY` is lower than the number of enabled slots. Run `fifo queue show --team eng --json` and look at `slots[].held`. |
| Webhooks never arrive | `WEBHOOK_DISPATCH_URL` unset (rows are `stubbed`), outside the 06:00–17:00 America/Denver weekday window, the title contains a hold word, the event type is housekeeping-only, or the item is on `team:parked`. Check `webhook_outbox.status` and `last_error`. |
| `wrangler d1 migrations apply --remote` fails | `database_id` in `wrangler.toml` is missing or wrong. |
| CLI keeps failing on an old request | A spooled request with bad credentials is being replayed; delete it from `~/.fifo-spool`. |

---

## Development

```bash
npm ci
npm test              # tsx --test test/*.test.ts (in-memory D1 stub, no Cloudflare needed)
npm run typecheck     # tsc for src/ and test/
npm run dev           # wrangler dev on :8787
npm run d1:local      # apply migrations to the local D1
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck` and
`npm test` on Node 22 for every push and pull request.

### Repository layout

```
cli/fifo.mjs        headless CLI (write-ahead spool, idempotency keys, --json)
migrations/         D1 migrations, applied in order by wrangler
schema.sql          convenience copy of the full schema
src/index.ts        Worker entry: routing, auth, idempotency, host split
src/fifo.ts         queue semantics: enqueue, claim, progress, done, block, move, reorder, shares
src/auth.ts         Access JWT / service token / bearer auth and permission checks
src/events.ts       CloudEvents envelope, HMAC signing, outbox, delivery, quiet rules
src/cron.ts         stall sweep, eng.hours.open, outbox retries
src/stall.ts        business-minute stall arithmetic
src/kind.ts         implement / ops / code_review classification and runtime labels
src/share.ts        HTML share board
src/db.ts           D1 helpers and first-request schema bootstrap
src/schema.ts       schema + seed SQL used by the bootstrap and tests
src/types.ts        Env bindings, permissions, row types
test/               node:test suites
wrangler.toml       Worker config, D1 binding, [vars], cron
```

### Adding a migration

Create `migrations/00NN_<name>.sql`, keep `schema.sql` and `src/schema.ts` in
sync, add a test in `test/migrations.test.ts`, then apply with `npm run
d1:local` (dev) or `--remote` (production).

---

## License

MIT — see `LICENSE`.
