import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramIdentity {
  telegramUserId: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
  startParam: string | null;
  replayIdentity: string;
}

export class InvalidTelegramInitData extends Error {
  constructor() {
    super("Invalid Telegram initData");
  }
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) throw new InvalidTelegramInitData();
  return value;
}

export function canonicalReplayIdentity(validatedHash: Uint8Array): string {
  return Buffer.from(validatedHash).toString("hex");
}

export function verifyTelegramInitData(
  raw: string,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 300
): TelegramIdentity {
  if (!raw || raw.length > 16_384 || !botToken || !Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new InvalidTelegramInitData();
  }

  const params = new URLSearchParams(raw);
  const fields = new Map<string, string>();
  for (const [key, value] of params) {
    if (!key || fields.has(key)) throw new InvalidTelegramInitData();
    fields.set(key, value);
  }

  const receivedHash = fields.get("hash");
  if (!receivedHash || !/^[0-9a-fA-F]{64}$/.test(receivedHash)) throw new InvalidTelegramInitData();
  fields.delete("hash");
  const dataCheckString = [...fields.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken, "utf8").digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString, "utf8").digest();
  if (!timingSafeEqual(Buffer.from(receivedHash, "hex"), expectedHash)) throw new InvalidTelegramInitData();

  const authDate = fields.get("auth_date");
  if (!authDate || !/^(0|[1-9][0-9]*)$/.test(authDate)) throw new InvalidTelegramInitData();
  const issuedAt = Number(authDate);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > nowSeconds || nowSeconds - issuedAt > maxAgeSeconds) {
    throw new InvalidTelegramInitData();
  }

  let user: unknown;
  try {
    user = JSON.parse(fields.get("user") ?? "");
  } catch {
    throw new InvalidTelegramInitData();
  }
  if (!user || typeof user !== "object" || Array.isArray(user)) throw new InvalidTelegramInitData();
  const data = user as Record<string, unknown>;
  if (!Number.isSafeInteger(data.id) || (data.id as number) <= 0 || data.is_bot === true ||
      typeof data.first_name !== "string" || data.first_name.length < 1 || data.first_name.length > 128) {
    throw new InvalidTelegramInitData();
  }
  const startParam = optionalText(fields.get("start_param"), 512);
  return {
    telegramUserId: String(data.id),
    firstName: data.first_name,
    lastName: optionalText(data.last_name, 128),
    username: optionalText(data.username, 64),
    languageCode: optionalText(data.language_code, 16),
    startParam,
    replayIdentity: canonicalReplayIdentity(expectedHash)
  };
}
