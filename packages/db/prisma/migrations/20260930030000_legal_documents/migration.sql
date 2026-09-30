CREATE TYPE "LegalDocumentType" AS ENUM ('PARTNER_TERMS', 'SALES_TERMS', 'PRIVACY');

CREATE TABLE "legal_documents" (
  "id" UUID NOT NULL,
  "type" "LegalDocumentType" NOT NULL,
  "version" VARCHAR(64) NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "content_markdown" TEXT NOT NULL,
  "requires_reacceptance" BOOLEAN NOT NULL DEFAULT false,
  "effective_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "legal_documents_type_version_key" ON "legal_documents"("type", "version");
CREATE UNIQUE INDEX "legal_documents_type_sha256_key" ON "legal_documents"("type", "sha256");

CREATE FUNCTION "reject_legal_document_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'legal_documents rows are immutable' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "legal_documents_immutable"
BEFORE UPDATE OR DELETE ON "legal_documents"
FOR EACH ROW EXECUTE FUNCTION "reject_legal_document_mutation"();
