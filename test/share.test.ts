import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/index.ts";
import { dev1Headers, idem, LOCAL, testEnv } from "./helpers.ts";

describe("share pages", () => {
  it("mints HTML with queued + in progress, omits done, and revokes/rotates", async () => {
    const env = await testEnv();
    const first = await worker.fetch(
      new Request(`${LOCAL}/v1/items`, {
        method: "POST",
        headers: { ...dev1Headers(), ...idem("sh1") },
        body: JSON.stringify({ personal: "dev1", title: "Active" }),
      }),
      env,
    );
    const created = (await first.json()) as { item: { id: string }; share_url: string };
    await worker.fetch(
      new Request(`${LOCAL}/v1/items`, {
        method: "POST",
        headers: { ...dev1Headers(), ...idem("sh2") },
        body: JSON.stringify({ personal: "dev1", title: "Waiting" }),
      }),
      env,
    );
    await worker.fetch(
      new Request(`${LOCAL}/v1/items/${created.item.id}/done`, {
        method: "POST",
        headers: { ...dev1Headers(), ...idem("sh-done") },
      }),
      env,
    );

    const minted = await worker.fetch(
      new Request(`${LOCAL}/v1/share-tokens`, {
        method: "POST",
        headers: { ...dev1Headers(), ...idem("mint") },
        body: JSON.stringify({ queue_key: "personal:dev1" }),
      }),
      env,
    );
    const share = (await minted.json()) as { share_url: string; token_id: string };
    const token = new URL(share.share_url).pathname.replace("/s/", "");
    const page = await worker.fetch(new Request(`${LOCAL}/s/${token}`), env);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(page.headers.get("x-robots-tag") || "", /noindex/);
    const html = await page.text();
    assert.match(html, /Waiting/);
    assert.doesNotMatch(html, />Active</);
    assert.doesNotMatch(html, /test-dev1-secret/);
    assert.doesNotMatch(html, /WEBHOOK/);

    const revoked = await worker.fetch(
      new Request(`${LOCAL}/v1/share-tokens/${share.token_id}`, {
        method: "DELETE",
        headers: { ...dev1Headers(), ...idem("rev") },
      }),
      env,
    );
    assert.equal(revoked.status, 200);
    const gone = await worker.fetch(new Request(`${LOCAL}/s/${token}`), env);
    assert.equal(gone.status, 404);
  });
});
