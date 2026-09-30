import { describe, expect, it } from "vitest";
import {
  PUBLIC_ORDER_NUMBER_PATTERN,
  generatePublicOrderNumber,
  insertWithPublicNumberRetry,
  isPublicOrderNumberUniqueViolation
} from "./order-number.js";

function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error("duplicate key"), { code: "23505", constraint });
}

describe("public order number", () => {
  it("generates display-safe W- prefixed 12-character Crockford Base32 numbers", () => {
    for (let index = 0; index < 200; index += 1) {
      const number = generatePublicOrderNumber();
      expect(number).toMatch(PUBLIC_ORDER_NUMBER_PATTERN);
      expect(number).toHaveLength(14);
      expect(number).not.toMatch(/[ILOU]/);
    }
  });

  it("draws numbers from cryptographic randomness without collisions", () => {
    const numbers = new Set(Array.from({ length: 10_000 }, () => generatePublicOrderNumber()));
    expect(numbers.size).toBe(10_000);
  });

  it("detects only the orders public-number unique violation", () => {
    expect(isPublicOrderNumberUniqueViolation(uniqueViolation("orders_public_number_key"))).toBe(true);
    expect(isPublicOrderNumberUniqueViolation(uniqueViolation("orders_buyer_idempotency_key"))).toBe(false);
    expect(isPublicOrderNumberUniqueViolation({ code: "23505", constraint: "orders_public_number_key" })).toBe(true);
    expect(isPublicOrderNumberUniqueViolation({ code: "23503", constraint: "orders_public_number_key" })).toBe(false);
    expect(isPublicOrderNumberUniqueViolation(new Error("duplicate key"))).toBe(false);
    expect(isPublicOrderNumberUniqueViolation(null)).toBe(false);
  });

  it("regenerates and retries only on the public-number unique violation", async () => {
    const numbers = ["W-000000000000", "W-000000000001", "W-000000000002"];
    let index = 0;
    const attempted: string[] = [];
    const inserted = await insertWithPublicNumberRetry(
      async (publicNumber) => {
        attempted.push(publicNumber);
        if (publicNumber !== numbers[numbers.length - 1]) throw uniqueViolation("orders_public_number_key");
        return { publicNumber };
      },
      () => numbers[index++]!,
      5
    );
    expect(attempted).toEqual(numbers);
    expect(inserted).toEqual({ publicNumber: "W-000000000002" });
  });

  it("propagates unrelated errors immediately", async () => {
    await expect(insertWithPublicNumberRetry(
      async () => {
        throw new Error("connection refused");
      },
      () => "W-000000000000"
    )).rejects.toThrow("connection refused");
  });

  it("gives up after the configured attempts", async () => {
    let attempts = 0;
    await expect(insertWithPublicNumberRetry(
      async () => {
        attempts += 1;
        throw uniqueViolation("orders_public_number_key");
      },
      () => `W-${attempts.toString().padStart(12, "0")}`,
      3
    )).rejects.toMatchObject({ constraint: "orders_public_number_key" });
    expect(attempts).toBe(3);
  });
});
