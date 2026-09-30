import { randomBytes } from "node:crypto";

// Crockford Base32: display-safe, no I/L/O/U.
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ORDER_NUMBER_DIGITS = 12;
export const PUBLIC_ORDER_NUMBER_PATTERN = /^W-[0-9A-HJKMNP-TV-Z]{12}$/;
export const ORDERS_PUBLIC_NUMBER_CONSTRAINT = "orders_public_number_key";

export function generatePublicOrderNumber(): string {
  const bytes = randomBytes(ORDER_NUMBER_DIGITS);
  let digits = "";
  for (let index = 0; index < ORDER_NUMBER_DIGITS; index += 1) {
    digits += CROCKFORD_BASE32[bytes[index]! % 32]!;
  }
  return `W-${digits}`;
}

export function isPublicOrderNumberUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === ORDERS_PUBLIC_NUMBER_CONSTRAINT;
}

export async function insertWithPublicNumberRetry<T>(
  insert: (publicNumber: string) => Promise<T>,
  generate: () => string = generatePublicOrderNumber,
  maxAttempts = 5
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await insert(generate());
    } catch (error) {
      if (!isPublicOrderNumberUniqueViolation(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
