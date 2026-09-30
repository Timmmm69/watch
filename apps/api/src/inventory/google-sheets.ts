import { GoogleAuth } from "google-auth-library";
import type { GoogleSheetsServiceAccount } from "@watch/config";
import type { InventoryProvider, InventorySnapshot, ProviderHealth } from "./provider.js";

export interface GoogleSheetsInventoryOptions {
  spreadsheetId: string;
  worksheetName: string;
  credentials: GoogleSheetsServiceAccount;
}

export interface GoogleSheetsBoundary {
  getAccessToken(): Promise<string | null | undefined>;
  fetch: typeof fetch;
}

export class GoogleSheetsInventoryProvider implements InventoryProvider {
  readonly key = "google_sheets";
  private readonly boundary: GoogleSheetsBoundary;
  private readonly url: string;

  constructor(options: GoogleSheetsInventoryOptions, boundary?: GoogleSheetsBoundary) {
    const auth = boundary ? undefined : new GoogleAuth({
      credentials: options.credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
      clientOptions: { transporterOptions: { timeout: 30000, retry: false } }
    });
    this.boundary = boundary ?? { getAccessToken: () => auth!.getAccessToken(), fetch };
    // A quoted sheet name requests the entire worksheet, including names with apostrophes.
    const range = `'${options.worksheetName.replaceAll("'", "''")}'`;
    this.url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(options.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
  }

  capabilities() {
    return { completeSnapshot: true, reservationReconciliation: "NONE" } as const;
  }

  async fetchSnapshot(): Promise<InventorySnapshot> {
    try {
      const token = await this.boundary.getAccessToken();
      if (!token) throw new Error();
      const response = await this.boundary.fetch(this.url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
        redirect: "error"
      });
      if (!response.ok) throw new Error();
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("values" in body) || !Array.isArray(body.values)) throw new Error();
      const [headers, ...rows] = body.values as unknown[];
      if (!Array.isArray(headers) || rows.some((row) => !Array.isArray(row))) throw new Error();
      const names = headers.map((cell: unknown) => typeof cell === "string" ? cell.trim() : "");
      const keyIndex = names.indexOf("external_key");
      const quantityIndex = names.indexOf("stock_quantity");
      if (keyIndex < 0 || quantityIndex < 0 || names.lastIndexOf("external_key") !== keyIndex ||
          names.lastIndexOf("stock_quantity") !== quantityIndex) throw new Error();
      const records = (rows as unknown[][])
        .filter((row) => !row.every((cell) => cell === null || cell === undefined || typeof cell === "string" && cell.trim() === ""))
        .map((row) => {
          const key = row[keyIndex];
          const raw = row[quantityIndex];
          // Text integers are common in operator-maintained Sheets. Never coerce blanks,
          // booleans, fractions or scientific notation into an apparently valid quantity.
          const quantity = typeof raw === "number" ? raw
            : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
          return { externalKey: typeof key === "string" ? key : "", quantity };
        });
      return { fetchedAt: new Date(), records };
    } catch {
      // Never propagate Google/Gaxios error objects, response bodies, tokens or credentials.
      throw new Error("GOOGLE_SHEETS_FETCH_FAILED");
    }
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await this.fetchSnapshot();
      return { ok: true, latencyMs: Date.now() - started };
    } catch {
      return { ok: false, latencyMs: Date.now() - started, error: "GOOGLE_SHEETS_FETCH_FAILED" };
    }
  }
}
