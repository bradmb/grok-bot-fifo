import type { CommentRow, ItemRow, QueueRow, SlotRow } from "./types";
import { PARKED_QUEUE_KEY } from "./types";
import { isCodeReviewItem } from "./kind";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(text: string, max = 280): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Cursor cloud agent session refs (bc-…) render as cursor.com/agents links.
 * Anything else stays plain text.
 */
const CURSOR_AGENTS_BASE = "https://cursor.com/agents/";

function sessionLink(label: string, ref: string, href: string | null): string {
  const value = href
    ? `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${esc(ref)}</a>`
    : esc(ref);
  return `<p class="who session-ref"><span class="who__label">${esc(label)}</span> ${value} <button type="button" class="copy-ref" data-ref="${esc(ref)}" aria-label="Copy ${esc(label)} ref">Copy</button></p>`;
}

/** Session links on active cards only (In Progress / Code Review). */
function sessionLinksHtml(item: ItemRow): string {
  if (item.state !== "in_progress" && item.state !== "code_review") {
    return "";
  }
  const rows: string[] = [];
  if (item.ca_ref) {
    rows.push(
      sessionLink(
        "CA session",
        item.ca_ref,
        /^bc-/.test(item.ca_ref) ? `${CURSOR_AGENTS_BASE}${item.ca_ref}` : null,
      ),
    );
  }
  if (item.factory_ref) {
    // No documented Factory session URL pattern — plain ref text + copy.
    rows.push(sessionLink("Factory session", item.factory_ref, /^https?:\/\//i.test(item.factory_ref) ? item.factory_ref : null));
  }
  return rows.join("\n  ");
}

function itemCard(
  item: ItemRow,
  names: Map<string, string>,
  comments: CommentRow[],
  position: number,
  focused: boolean,
): string {
  const assignee = item.assignee_agent_id
    ? names.get(item.assignee_agent_id) || item.assignee_agent_id
    : "Unassigned";
  const stateLabel =
    item.state === "in_progress" ? "In progress" : item.state === "code_review" ? "Code review" : "Queued";
  const stateClass =
    item.state === "in_progress" ? "pill pill--live" : item.state === "code_review" ? "pill pill--cr" : "pill pill--queued";
  const crTag =
    item.state !== "code_review" && isCodeReviewItem(item) ? `<span class="pill pill--cr">Code Review</span>` : "";
  const crSeat = item.state === "code_review" && item.cr_slot
    ? `<p class="who"><span class="who__label">CR slot</span> ${esc(item.cr_slot)}</p>`
    : "";
  const block = item.hard_blocked_at
    ? `<p class="block"><span class="pill pill--block">Hard-blocked</span> ${esc(item.block_reason || "")}</p>`
    : "";
  const noteList = comments.map((c) => `<li>${esc(truncate(c.body, 160))}</li>`).join("");
  const notes = noteList ? `<ul class="notes">${noteList}</ul>` : "";
  const body = item.body ? `<p class="body">${esc(truncate(item.body))}</p>` : "";
  return `<article class="card${focused ? " card--focus" : ""}">
  <div class="card__top">
    <span class="pos">#${position}</span>
    <span class="${stateClass}">${stateLabel}</span>
    ${crTag}
  </div>
  <h3>${esc(item.title)}</h3>
  <p class="who"><span class="who__label">Assignee</span> ${esc(assignee)}</p>
  ${crSeat}
  ${sessionLinksHtml(item)}
  ${body}
  ${block}
  ${notes}
</article>`;
}

function emptyState(kind: "wip" | "queued"): string {
  if (kind === "wip") {
    return `<div class="empty">
  <strong>Nothing in progress</strong>
  <p>When an IC claims the next item, it lands here.</p>
</div>`;
  }
  return `<div class="empty">
  <strong>Queue is clear</strong>
  <p>New eng work will show up here in order.</p>
</div>`;
}

export function renderShareHtml(input: {
  queue: QueueRow;
  queued: ItemRow[];
  wip: ItemRow[];
  cr?: ItemRow[];
  slots: SlotRow[];
  names: Map<string, string>;
  comments: Map<string, CommentRow[]>;
  focusItemId: string | null;
  occupancy: number;
  codeReviewOccupancy?: number;
}): string {
  const crItems = input.cr || [];
  const focusQueuedIndex = input.focusItemId
    ? input.queued.findIndex((item) => item.id === input.focusItemId)
    : -1;
  const focusWip = input.focusItemId ? input.wip.some((item) => item.id === input.focusItemId) : false;
  const focusCr = input.focusItemId ? crItems.some((item) => item.id === input.focusItemId) : false;
  let focusLine = "";
  if (input.focusItemId) {
    if (focusWip) {
      focusLine = `<div class="focus" role="status"><strong>Your item is in progress.</strong> It is live on a Factory seat.</div>`;
    } else if (focusCr) {
      focusLine = `<div class="focus" role="status"><strong>Your item is in code review.</strong> It runs on a Cursor cloud VM.</div>`;
    } else if (focusQueuedIndex >= 0) {
      const n = focusQueuedIndex + 1;
      focusLine = `<div class="focus" role="status"><strong>Your item is #${n} in Queued.</strong> Code Review and Factory seats are separate lanes.</div>`;
    }
  }

  const wipHtml = input.wip
    .map((item, i) =>
      itemCard(item, input.names, input.comments.get(item.id) || [], i + 1, item.id === input.focusItemId),
    )
    .join("");
  const crHtml = crItems
    .map((item, i) =>
      itemCard(item, input.names, input.comments.get(item.id) || [], i + 1, item.id === input.focusItemId),
    )
    .join("");
  const queuedHtml = input.queued
    .map((item, i) =>
      itemCard(
        item,
        input.names,
        input.comments.get(item.id) || [],
        i + 1,
        item.id === input.focusItemId,
      ),
    )
    .join("");

  const isParked = input.queue.queue_key === PARKED_QUEUE_KEY;
  const kindPill = isParked
    ? `<span class="pill pill--park">Parked</span>`
    : input.queue.kind === "team"
      ? `<span class="pill pill--team">Team</span>`
      : `<span class="pill pill--personal">Personal</span>`;

  const cap = isParked
    ? `<p class="cap">Hold lane · not claimable · no IC slots</p>`
    : input.queue.kind === "team"
      ? `<p class="cap"><span>${esc(String(input.occupancy))}</span> / ${esc(String(input.queue.capacity))} Factory seats · <span>${esc(String(input.codeReviewOccupancy ?? crItems.length))}</span> Code Review (Cursor cloud VM)</p>`
      : `<p class="cap"><span>${esc(String(input.occupancy))}</span> in progress on this plate</p>`;

  const showCr = input.queue.kind === "team";
  const crCol = showCr
    ? `<section class="col" aria-labelledby="cr-h">
      <div class="col__head">
        <h2 id="cr-h">Code Review</h2>
        <span class="count">${crItems.length}</span>
      </div>
      ${crHtml || `<div class="empty">
  <strong>No code review</strong>
  <p>CR claims land here on a Cursor cloud VM, separate from Factory seats.</p>
</div>`}
    </section>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex,nofollow">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#fbf8f3">
  <title>${esc(input.queue.title)} · FIFO share</title>
  <style>
    :root {
      --ink: #2a2c2f;
      --slate: #67696b;
      --mute: #8b8d90;
      --paper: #fbf8f3;
      --paper-deep: #f3ede4;
      --card: #ffffff;
      --line: #e7dfd3;
      --orange: #f47b3d;
      --orange-deep: #f26828;
      --orange-soft: #fde9dc;
      --green: #00a881;
      --green-soft: #e8f5f0;
      --radius: 16px;
      --shadow: 0 1px 2px rgba(42,44,47,.05), 0 12px 32px -16px rgba(42,44,47,.18);
      --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      font-family: var(--font);
      font-size: clamp(0.98rem, 0.95rem + 0.15vw, 1.05rem);
      line-height: 1.5;
      color: var(--ink);
      background: var(--paper);
      background-image:
        radial-gradient(50rem 24rem at 110% -10%, rgba(244,123,61,.10), transparent 60%),
        radial-gradient(36rem 20rem at -15% 0%, rgba(0,168,129,.06), transparent 55%);
      background-repeat: no-repeat;
      min-height: 100vh;
    }
    .skip {
      position: absolute; left: -999px; top: 0; background: var(--ink); color: #fff; padding: .5rem 1rem;
    }
    .skip:focus { left: 1rem; top: 1rem; z-index: 10; }
    .wrap { width: min(1280px, calc(100% - 2rem)); margin-inline: auto; }
    header.top {
      display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
      gap: 1rem; padding: 1.5rem 0 1rem;
    }
    .brand { display: grid; gap: .45rem; min-width: 0; }
    .brand__row { display: flex; flex-wrap: wrap; align-items: center; gap: .55rem; }
    h1 {
      margin: 0; font-size: clamp(1.55rem, 1.2rem + 1.4vw, 2.1rem);
      line-height: 1.15; letter-spacing: -.02em; font-weight: 800; text-wrap: balance;
    }
    .cap { margin: 0; color: var(--slate); font-size: .95rem; }
    .cap span { color: var(--ink); font-weight: 700; }
    .eyebrow {
      margin: 0; font-size: .72rem; font-weight: 700; letter-spacing: .12em;
      text-transform: uppercase; color: var(--orange-deep);
    }
    .pill {
      display: inline-flex; align-items: center; font: 700 .7rem/1 var(--font);
      letter-spacing: .06em; text-transform: uppercase; padding: .35rem .55rem; border-radius: 999px;
      background: var(--paper-deep); color: var(--slate);
    }
    .pill--team { background: var(--orange-soft); color: var(--orange-deep); }
    .pill--personal { background: #e8eef8; color: #35507a; }
    .pill--park { background: #eceff3; color: #495057; }
    .pill--live { background: var(--green-soft); color: var(--green); }
    .pill--queued { background: var(--paper-deep); color: var(--slate); }
    .pill--cr { background: #e8eef8; color: #35507a; }
    .pill--block { background: #fde8e4; color: #b42318; }
    .focus {
      background: var(--ink); color: #fff; border-radius: 12px; padding: .85rem 1.1rem;
      margin: 0 0 1.25rem; box-shadow: var(--shadow);
    }
    .focus strong { font-weight: 800; }
    .cols {
      display: grid; gap: 1.25rem; grid-template-columns: 1fr;
      padding-bottom: 2.5rem;
    }
    @media (min-width: 860px) { .cols { grid-template-columns: 1fr 1fr; gap: 1.5rem; } }
    @media (min-width: 1100px) { .cols.cols--eng { grid-template-columns: 1fr 1fr 1fr; gap: 1.25rem; } }
    .col {
      background: rgba(255,255,255,.45); border: 1px solid var(--line);
      border-radius: calc(var(--radius) + 4px); padding: 1rem 1rem 1.15rem;
      min-width: 0;
    }
    .col__head {
      display: flex; align-items: baseline; justify-content: space-between; gap: .75rem;
      margin: 0 0 .85rem; padding: 0 .15rem;
    }
    .col__head h2 {
      margin: 0; font-size: 1.05rem; letter-spacing: -.01em; font-weight: 800;
    }
    .count {
      font: 700 .78rem/1 var(--font); color: var(--mute); letter-spacing: .04em;
    }
    .card {
      background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
      box-shadow: var(--shadow); padding: 1rem 1.1rem 1.05rem; margin: 0 0 .85rem;
    }
    .card:last-child { margin-bottom: 0; }
    .card--focus {
      border-color: var(--orange);
      box-shadow: 0 0 0 2px rgba(244,123,61,.25), var(--shadow);
    }
    .card__top { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: .45rem; }
    .pos { font: 700 .78rem/1 var(--font); color: var(--mute); letter-spacing: .04em; }
    .card h3 {
      margin: 0 0 .45rem; font-size: 1.05rem; line-height: 1.3; letter-spacing: -.015em;
      font-weight: 800; text-wrap: balance;
    }
    .who { margin: 0 0 .55rem; color: var(--slate); font-size: .92rem; }
    .who__label { color: var(--mute); font-size: .75rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; margin-right: .35rem; }
    .session-ref a { color: var(--orange-deep); font-weight: 600; text-decoration: none; word-break: break-all; }
    .session-ref a:hover { text-decoration: underline; }
    .copy-ref {
      margin-left: .35rem; font: 600 .72rem/1 var(--font); letter-spacing: .04em;
      color: var(--slate); background: var(--paper-deep); border: 1px solid var(--line);
      border-radius: 999px; padding: .22rem .6rem; cursor: pointer;
    }
    .copy-ref:hover { color: var(--ink); border-color: var(--mute); }
    .body { margin: 0; color: var(--slate); font-size: .95rem; }
    .block { margin: .65rem 0 0; color: var(--slate); font-size: .9rem; display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
    .notes { margin: .7rem 0 0; padding-left: 1.15rem; color: var(--slate); font-size: .9rem; }
    .notes li { margin: .25rem 0; }
    .empty {
      border: 1px dashed #d9cfc0; border-radius: var(--radius); padding: 1.35rem 1.1rem;
      text-align: center; color: var(--slate); background: rgba(255,255,255,.55);
    }
    .empty strong { display: block; color: var(--ink); font-weight: 800; margin-bottom: .25rem; }
    .empty p { margin: 0; font-size: .92rem; }
    footer {
      border-top: 1px solid var(--line); padding: 1.25rem 0 2rem; color: var(--mute); font-size: .85rem;
    }
    footer .wrap { display: flex; flex-wrap: wrap; gap: .75rem 1.25rem; justify-content: space-between; align-items: center; }
  </style>
</head>
<body>
  <a class="skip" href="#board">Skip to board</a>
  <header class="wrap top">
    <div class="brand">
      <p class="eyebrow">FIFO share</p>
      <div class="brand__row">
        <h1>${esc(input.queue.title)}</h1>
        ${kindPill}
      </div>
      ${cap}
    </div>
  </header>
  <div class="wrap" id="status-line">${focusLine}</div>
  <main id="board" class="wrap cols${showCr ? " cols--eng" : ""}">
    <section class="col" aria-labelledby="q-h">
      <div class="col__head">
        <h2 id="q-h">Queued</h2>
        <span class="count">${input.queued.length}</span>
      </div>
      ${queuedHtml || emptyState("queued")}
    </section>
    <section class="col" aria-labelledby="wip-h">
      <div class="col__head">
        <h2 id="wip-h">In progress</h2>
        <span class="count">${input.wip.length}</span>
      </div>
      ${wipHtml || emptyState("wip")}
    </section>
    ${crCol}
  </main>
  <footer>
    <div class="wrap">
      <span>Read-only share · ${esc(input.queue.queue_key)}</span>
      <span>FIFO worker</span>
    </div>
  </footer>
  <script>
    // Modest live refresh (15s poll) so session links and lane moves
    // appear without a full page reload; plus copy buttons for plain refs.
    (function () {
      document.addEventListener("click", function (e) {
        var target = e.target;
        var btn = target && target.closest ? target.closest(".copy-ref") : null;
        if (!btn) return;
        var ref = btn.getAttribute("data-ref") || "";
        var done = function () {
          btn.textContent = "Copied";
          setTimeout(function () { btn.textContent = "Copy"; }, 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(ref).then(done, done);
        } else {
          done();
        }
      });
      function swap(sel, doc) {
        var next = doc.querySelector(sel);
        var cur = document.querySelector(sel);
        if (!next || !cur) return false;
        if (cur.outerHTML === next.outerHTML) return false;
        cur.replaceWith(document.importNode(next, true));
        return true;
      }
      function poll() {
        fetch(location.href, { headers: { Accept: "text/html" } })
          .then(function (res) { return res.ok ? res.text() : null; })
          .then(function (text) {
            if (!text) return;
            var doc = new DOMParser().parseFromString(text, "text/html");
            swap("main#board", doc);
            swap("#status-line", doc);
          })
          .catch(function () { /* offline: keep the current board */ });
      }
      setInterval(poll, 15000);
    })();
  </script>
</body>
</html>`;
}
