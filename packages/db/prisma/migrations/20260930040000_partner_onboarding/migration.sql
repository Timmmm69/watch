CREATE TYPE "PartnerStatus" AS ENUM ('ACTIVE', 'BLOCKED');

CREATE TABLE "partners" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "status" "PartnerStatus" NOT NULL DEFAULT 'ACTIVE',
  "block_reason" TEXT,
  "blocked_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "partner_terms_acceptances" (
  "partner_id" UUID NOT NULL,
  "legal_document_id" UUID NOT NULL,
  "accepted_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "partner_terms_acceptances_pkey" PRIMARY KEY ("partner_id","legal_document_id")
);

CREATE TABLE "audit_logs" (
  "id" UUID NOT NULL,
  "actor_user_id" UUID,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "request_id" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "partners_user_id_key" ON "partners"("user_id");
CREATE INDEX "partners_status_idx" ON "partners"("status");
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

ALTER TABLE "partners" ADD CONSTRAINT "partners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "partner_terms_acceptances" ADD CONSTRAINT "partner_terms_acceptances_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "partner_terms_acceptances" ADD CONSTRAINT "partner_terms_acceptances_legal_document_id_fkey" FOREIGN KEY ("legal_document_id") REFERENCES "legal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
