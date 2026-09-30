import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabasePool } from "@watch/db";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const validTypes = ["PARTNER_TERMS", "SALES_TERMS", "PRIVACY"] as const;

function parseArgs(argv: string[]): {
  type: string | undefined;
  version: string | undefined;
  file: string | undefined;
  requiresReacceptance: boolean;
  effectiveAt: string | undefined;
} {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "requires-reacceptance") {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  return {
    type: args.type as string | undefined,
    version: args.version as string | undefined,
    file: args.file as string | undefined,
    requiresReacceptance: args["requires-reacceptance"] === true,
    effectiveAt: args["effective-at"] as string | undefined
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.type || !validTypes.includes(args.type as (typeof validTypes)[number])) {
    throw new Error("--type must be one of PARTNER_TERMS | SALES_TERMS | PRIVACY");
  }
  const type = args.type as (typeof validTypes)[number];
  if (!args.version || args.version.length < 1 || args.version.length > 64) {
    throw new Error("--version is required (1..64 characters)");
  }
  if (!args.file) throw new Error("--file is required");

  const effectiveAt = args.effectiveAt ? new Date(args.effectiveAt) : new Date();
  if (Number.isNaN(effectiveAt.getTime())) throw new Error("--effective-at must be a valid date");

  const content = await readFile(args.file, "utf8");
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = createDatabasePool(databaseUrl);

  try {
    const existingVersion = await pool.query<{ id: string; sha256: string }>(
      "SELECT id, sha256 FROM legal_documents WHERE type = $1::\"LegalDocumentType\" AND version = $2",
      [type, args.version]
    );
    const reused = existingVersion.rows[0];
    if (reused) {
      console.log(JSON.stringify({ id: reused.id, type, version: args.version, sha256: reused.sha256, reused: true }));
      return;
    }

    const existingSha = await pool.query<{ version: string }>(
      "SELECT version FROM legal_documents WHERE type = $1::\"LegalDocumentType\" AND sha256 = $2",
      [type, sha256]
    );
    const sameContent = existingSha.rows[0];
    if (sameContent) {
      throw new Error(`Content already published as ${type} version ${sameContent.version}`);
    }

    const inserted = await pool.query<{ id: string }>(
      "INSERT INTO legal_documents (id, type, version, sha256, content_markdown, requires_reacceptance, effective_at) VALUES ($1, $2::\"LegalDocumentType\", $3, $4, $5, $6, $7) RETURNING id",
      [randomUUID(), type, args.version, sha256, content, args.requiresReacceptance ?? false, effectiveAt]
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("Legal document insert failed");
    console.log(JSON.stringify({ id, type, version: args.version, sha256 }));
  } finally {
    await pool.end();
  }
}

await main();
