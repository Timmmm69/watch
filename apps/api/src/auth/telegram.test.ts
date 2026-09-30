import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InvalidTelegramInitData, verifyTelegramInitData } from "./telegram.js";

const botToken = "123456:fixture-bot-token";
const now = 1_800_000_000;
const user = JSON.stringify({ id: 123456789, first_name: "Ada", last_name: "Lovelace", username: "ada" });

function sign(entries: [string, string][]): string {
  const params = new URLSearchParams(entries);
  const canonical = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(canonical).digest("hex");
  params.append("hash", hash);
  return params.toString();
}

describe("Telegram Mini App initData", () => {
  const fields: [string, string][] = [["auth_date", String(now)], ["user", user], ["start_param", "r_token"]];

  it("validates the exact Mini App HMAC and preserves signed identity", () => {
    expect(verifyTelegramInitData(sign(fields), botToken, now)).toMatchObject({
      telegramUserId: "123456789", firstName: "Ada", lastName: "Lovelace",
      username: "ada", startParam: "r_token"
    });
  });

  it("uses the same replay identity for reordered query fields", () => {
    const first = verifyTelegramInitData(sign(fields), botToken, now);
    const second = verifyTelegramInitData(sign([...fields].reverse()), botToken, now);
    expect(first.replayIdentity).toBe(second.replayIdentity);
    expect(first.replayIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyTelegramInitData(sign([...fields.slice(0, 2), ["start_param", "r_other"]]), botToken, now).replayIdentity)
      .not.toBe(first.replayIdentity);
  });

  it("rejects duplicate keys even when the HMAC covers them", () => {
    expect(() => verifyTelegramInitData(sign([...fields, ["user", user]]), botToken, now)).toThrow(InvalidTelegramInitData);
    expect(() => verifyTelegramInitData(`${sign(fields)}&hash=${"0".repeat(64)}`, botToken, now)).toThrow(InvalidTelegramInitData);
  });

  it("rejects tampering, bad hash encoding, stale or future dates", () => {
    expect(() => verifyTelegramInitData(sign(fields).replace("r_token", "r_other"), botToken, now)).toThrow();
    expect(() => verifyTelegramInitData(sign(fields), "wrong-token", now)).toThrow();
    expect(() => verifyTelegramInitData(sign(fields).replace(/hash=[^&]+/, "hash=xyz"), botToken, now)).toThrow();
    expect(() => verifyTelegramInitData(sign(fields), botToken, now + 301)).toThrow();
    expect(() => verifyTelegramInitData(sign(fields), botToken, now - 1)).toThrow();
  });

  it("requires a human Telegram User only after verifying the signature", () => {
    const noUser = sign([["auth_date", String(now)]]);
    const botUser = sign([["auth_date", String(now)], ["user", JSON.stringify({ id: 42, first_name: "Bot", is_bot: true })]]);
    expect(() => verifyTelegramInitData(noUser, botToken, now)).toThrow();
    expect(() => verifyTelegramInitData(botUser, botToken, now)).toThrow();
  });
});
