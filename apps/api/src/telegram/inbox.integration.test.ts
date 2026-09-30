import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { TelegramInbox } from "./inbox.js";

const pool = process.env.TEST_DATABASE_URL ? new Pool({ connectionString: process.env.TEST_DATABASE_URL }) : null;
const inbox = pool ? new TelegramInbox(pool) : null;
const ids: string[] = [];

afterAll(async () => {
  if (!pool) return;
  if (ids.length) await pool.query("DELETE FROM telegram_updates WHERE update_id = ANY($1::bigint[])", [ids]);
  await pool.end();
});

describe.skipIf(!pool)("Telegram inbox against PostgreSQL", () => {
  it("dedupes, claims once and recovers expired leases", async () => {
    const id = String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
    ids.push(id);
    await inbox!.insert(id, { update_id: Number(id), message: { text: "/start" } });
    await inbox!.insert(id, { update_id: Number(id), message: { text: "/help" } });
    const count = await pool!.query<{ count: string }>("SELECT count(*)::text AS count FROM telegram_updates WHERE update_id = $1", [id]);
    expect(count.rows[0]?.count).toBe("1");
    const first = await inbox!.claim();
    expect(first?.update_id).toBe(id);
    expect(first?.attempts).toBe(1);
    expect(await inbox!.claim()).toBeNull();
    await pool!.query("UPDATE telegram_updates SET lease_expires_at = now() - interval '1 second' WHERE update_id = $1", [id]);
    const recovered = await inbox!.claim();
    expect(recovered?.update_id).toBe(id);
    expect(recovered?.attempts).toBe(2);
    await inbox!.complete(first!);
    const processing = await pool!.query<{ status: string }>("SELECT status FROM telegram_updates WHERE update_id = $1", [id]);
    expect(processing.rows[0]?.status).toBe("PROCESSING");
    await inbox!.complete(recovered!);
    const done = await pool!.query<{ status: string }>("SELECT status FROM telegram_updates WHERE update_id = $1", [id]);
    expect(done.rows[0]?.status).toBe("PROCESSED");
  });
});
