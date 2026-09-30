import { describe, expect, it, vi } from "vitest";
import { GoogleSheetsInventoryProvider } from "./google-sheets.js";
import { normalizeInventorySnapshot } from "./normalize.js";

const options = { spreadsheetId: "sheet-id", worksheetName: "Supplier's stock",
  credentials: { type: "service_account" as const, project_id: "project", client_email: "test@example.com", private_key: "secret-key" } };

function provider(values: unknown) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ values })));
  const getAccessToken = vi.fn().mockResolvedValue("secret-token");
  return { source: new GoogleSheetsInventoryProvider(options, { getAccessToken, fetch: fetchMock }), fetchMock, getAccessToken };
}

describe("Google Sheets physical inventory", () => {
  it("fetches the complete named worksheet and ignores commercial/SKU columns without fabricating versions", async () => {
    const { source, fetchMock } = provider([
      ["sku", "stock_quantity", "external_key", "price_minor", "status", "commission"],
      ["unrelated-sku", 12, "key-a", 99999, "ACTIVE", 55],
      ["other", " 0 ", "key-b"], [], ["", "", ""], [null, null]
    ]);
    const snapshot = await source.fetchSnapshot();
    expect(snapshot).toEqual({ fetchedAt: expect.any(Date), records: [
      { externalKey: "key-a", quantity: 12 }, { externalKey: "key-b", quantity: 0 }
    ] });
    expect(source.capabilities()).toEqual({ completeSnapshot: true, reservationReconciliation: "NONE" });
    expect(snapshot).not.toHaveProperty("sourceVersion");
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(decodeURIComponent(url.pathname)).toBe("/v4/spreadsheets/sheet-id/values/'Supplier''s stock'");
    expect(url.searchParams.get("valueRenderOption")).toBe("UNFORMATTED_VALUE");
    expect(url.searchParams.get("majorDimension")).toBe("ROWS");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "error", headers: { authorization: "Bearer secret-token" } });
  });

  it.each([undefined, "", " ", "abc", "1.2", "1e3", true, -1, 1.5, 2147483648])("passes malformed quantity %s to generic fail-closed validation", async (quantity) => {
    const { source } = provider([["external_key", "stock_quantity"], ["mapped", quantity]]);
    const result = normalizeInventorySnapshot(await source.fetchSnapshot());
    expect(result).toMatchObject({ kind: "valid", snapshot: { records: [], issues: [{ kind: "INVALID_QUANTITY", externalKey: "mapped" }] } });
  });

  it("preserves duplicates and malformed keys for generic validation", async () => {
    const { source } = provider([["external_key", "stock_quantity"], ["mapped", 5], ["mapped", 7], ["", 3], [123, 2]]);
    const result = normalizeInventorySnapshot(await source.fetchSnapshot());
    expect(result).toMatchObject({ kind: "valid", snapshot: { issues: [
      { kind: "DUPLICATE_KEY", externalKey: "mapped" }, { kind: "INVALID_KEY" }, { kind: "INVALID_KEY" }
    ] } });
  });

  it("accepts a header-only snapshot", async () => {
    expect((await provider([["external_key", "stock_quantity"]]).source.fetchSnapshot()).records).toEqual([]);
  });

  it.each([[], [["sku", "stock_quantity"]], [["external_key"]], [["external_key", "stock_quantity", "external_key"]], [["external_key", "stock_quantity"], {}]].map((values) => [values]))("rejects missing/ambiguous headers or malformed responses", async (values) => {
    await expect(provider(values).source.fetchSnapshot()).rejects.toThrow("GOOGLE_SHEETS_FETCH_FAILED");
  });

  it("sanitizes auth, API, network and JSON errors and health results", async () => {
    const boundaries = [
      { getAccessToken: vi.fn().mockRejectedValue(new Error("secret-key secret-token")), fetch: vi.fn<typeof fetch>() },
      { getAccessToken: vi.fn().mockResolvedValue(null), fetch: vi.fn<typeof fetch>() },
      { getAccessToken: vi.fn().mockResolvedValue("secret-token"), fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("secret-token")) },
      { getAccessToken: vi.fn().mockResolvedValue("secret-token"), fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-key", { status: 403 })) },
      { getAccessToken: vi.fn().mockResolvedValue("secret-token"), fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-key")) }
    ];
    for (const boundary of boundaries) {
      const source = new GoogleSheetsInventoryProvider(options, boundary);
      await expect(source.fetchSnapshot()).rejects.toEqual(new Error("GOOGLE_SHEETS_FETCH_FAILED"));
      expect(await source.health()).toMatchObject({ ok: false, error: "GOOGLE_SHEETS_FETCH_FAILED" });
    }
    expect(await provider([["external_key", "stock_quantity"]]).source.health()).toMatchObject({ ok: true, latencyMs: expect.any(Number) });
  });
});
