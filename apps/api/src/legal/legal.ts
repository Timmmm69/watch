import type { Pool } from "pg";
import type { LegalDocumentRef, LegalDocumentType } from "@watch/config";

export interface LegalDocumentProjection {
  id: string;
  type: LegalDocumentType;
  version: string;
  sha256: string;
  contentMarkdown: string;
  effectiveAt: string;
  requiresReacceptance: boolean;
}

interface LegalDocumentRow {
  id: string;
  type: LegalDocumentType;
  version: string;
  sha256: string;
  content_markdown: string;
  requires_reacceptance: boolean;
  effective_at: Date;
}

function mapDocument(row: LegalDocumentRow): LegalDocumentProjection {
  return {
    id: row.id,
    type: row.type,
    version: row.version,
    sha256: row.sha256,
    contentMarkdown: row.content_markdown,
    effectiveAt: row.effective_at.toISOString(),
    requiresReacceptance: row.requires_reacceptance
  };
}

export class LegalDocuments {
  constructor(
    private readonly pool: Pool,
    private readonly currentDocs: Partial<Record<LegalDocumentType, LegalDocumentRef>>
  ) {}

  async getCurrent(type: LegalDocumentType): Promise<LegalDocumentProjection | null> {
    const ref = this.currentDocs[type];
    if (!ref) return null;
    const result = await this.pool.query<LegalDocumentRow>(`
      SELECT id, type, version, sha256, content_markdown, requires_reacceptance, effective_at
      FROM legal_documents
      WHERE id = $1 AND type = $2::"LegalDocumentType"
    `, [ref.id, type]);
    const row = result.rows[0];
    return row ? mapDocument(row) : null;
  }

  async verifyCurrentConfigured(): Promise<void> {
    for (const [type, ref] of Object.entries(this.currentDocs) as [LegalDocumentType, LegalDocumentRef][]) {
      const result = await this.pool.query<{ type: LegalDocumentType; version: string; effective_at: Date }>(`
        SELECT type, version, effective_at FROM legal_documents WHERE id = $1
      `, [ref.id]);
      const row = result.rows[0];
      if (!row) throw new Error(`Configured current ${type} legal document ${ref.id} is not published`);
      if (row.type !== type) throw new Error(`Configured current ${type} legal document ${ref.id} has type ${row.type}`);
      if (row.version !== ref.version) throw new Error(`Configured current ${type} legal document ${ref.id} version mismatch`);
      if (row.effective_at > new Date()) throw new Error(`Configured current ${type} legal document ${ref.id} is not yet effective`);
    }
  }
}
