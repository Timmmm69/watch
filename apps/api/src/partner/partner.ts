import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { LegalDocuments } from "../legal/legal.js";

export type PartnerStatus = "ACTIVE" | "BLOCKED";

export interface PartnerSummary {
  id: string;
  status: PartnerStatus;
}

export interface PartnerState {
  partner: PartnerSummary | null;
  partnerTermsReacceptRequired: boolean;
}

export type OnboardResult =
  | { kind: "ok"; partner: PartnerSummary }
  | { kind: "stale"; currentDocument: { id: string; version: string } };

export function partnerTermsCurrent(requiresReacceptance: boolean, currentAccepted: boolean): boolean {
  return currentAccepted || !requiresReacceptance;
}

export function partnerProgramMutationAllowed(params: {
  userBlocked: boolean;
  partnerStatus: PartnerStatus;
  partnerTermsCurrent: boolean;
}): boolean {
  return !params.userBlocked && params.partnerStatus === "ACTIVE" && params.partnerTermsCurrent;
}

interface PartnerRow {
  id: string;
  status: PartnerStatus;
}

export class PartnerService {
  constructor(
    private readonly pool: Pool,
    private readonly legal: LegalDocuments
  ) {}

  async loadState(userId: string): Promise<PartnerState> {
    const result = await this.pool.query<PartnerRow>("SELECT id, status FROM partners WHERE user_id = $1", [userId]);
    const partner = result.rows[0];
    if (!partner) return { partner: null, partnerTermsReacceptRequired: false };
    const current = await this.legal.getCurrent("PARTNER_TERMS");
    const accepted = current ? await this.hasAccepted(partner.id, current.id) : false;
    const reacceptRequired = current ? !partnerTermsCurrent(current.requiresReacceptance, accepted) : false;
    return { partner: { id: partner.id, status: partner.status }, partnerTermsReacceptRequired: reacceptRequired };
  }

  async onboard(userId: string, documentId: string, documentVersion: string): Promise<OnboardResult> {
    const current = await this.legal.getCurrent("PARTNER_TERMS");
    if (!current) throw new Error("No current PARTNER_TERMS document is configured");
    if (documentId !== current.id || documentVersion !== current.version) {
      return { kind: "stale", currentDocument: { id: current.id, version: current.version } };
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<PartnerRow>(`
        INSERT INTO partners (user_id) VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING
        RETURNING id, status
      `, [userId]);
      let partner = inserted.rows[0];
      if (!partner) {
        const locked = await client.query<PartnerRow>(
          "SELECT id, status FROM partners WHERE user_id = $1 FOR UPDATE", [userId]
        );
        partner = locked.rows[0];
      }
      if (!partner) throw new Error("Partner creation failed");
      await client.query(
        "INSERT INTO partner_terms_acceptances (partner_id, legal_document_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [partner.id, current.id]
      );
      if (inserted.rows[0]) {
        await client.query(
          `INSERT INTO events (id, type, aggregate_type, aggregate_id, dedupe_key, payload, created_at)
           VALUES ($1, 'PARTNER_ACTIVATED', 'Partner', $2, $3, $4, now())`,
          [randomUUID(), partner.id, `partner:${partner.id}:activated`, JSON.stringify({ v: 1, partnerId: partner.id })]
        );
      }
      await client.query("COMMIT");
      return { kind: "ok", partner: { id: partner.id, status: partner.status } };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async hasAccepted(partnerId: string, documentId: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM partner_terms_acceptances WHERE partner_id = $1 AND legal_document_id = $2",
      [partnerId, documentId]
    );
    return result.rows.length > 0;
  }
}
