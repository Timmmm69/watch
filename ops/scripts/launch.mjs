import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { verifyBackupConfiguration } from "./backup.mjs";
import { root } from "./compose.mjs";

export function verifyReleaseSource(releaseSha, git = args => execFileSync("git", args, {cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim()) {
  if (git(["rev-parse","HEAD"]).trim() !== releaseSha) throw new Error("Checkout HEAD differs from the release image SHA");
  if (git(["status","--porcelain","--untracked-files=normal"]).trim()) throw new Error("Release build requires a clean reviewed checkout, including untracked source files");
}

/** Validate using the built API image; the host needs only Node/Docker, no workspace dependencies. */
export async function verifyLaunchInputs(config, run, env = process.env, verifyBackup = verifyBackupConfiguration, read = readFile) {
  const mount = config.services.api.volumes?.find((volume) => volume.target === "/run/production-approval.json");
  if (!mount || mount.type !== "bind" || !mount.read_only) throw new Error("Production requires a read-only approval bind mount");
  if (!isAbsolute(mount.source)) throw new Error("Production approval source must be absolute");
  const bytes = await read(mount.source);
  const verified = JSON.parse(await run(["run", "--rm", "--no-deps", "api", "node", "apps/api/dist/operations/cli.js", "config"]));
  if (verified.status !== "ok" || verified.productionApprovalSha256 !== createHash("sha256").update(bytes).digest("hex")) {
    throw new Error("Mounted production approval differs from the validated file");
  }
  const approval = JSON.parse(bytes.toString("utf8"));
  for (const name of ["api", "worker", "bootstrap"]) {
    const service=config.services[name];
    if (service?.environment?.INVENTORY_PROVIDER !== approval.operatingModel.inventoryProvider) {
      throw new Error("Deployment inventory authority differs from approved operating model");
    }
    if (approval.operatingModel.inventoryProvider === "native" &&
      (service.environment.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64_FILE || service.secrets?.some(secret=>secret.source === "google_service_account"))) {
      throw new Error("Native deployment requires the Compose overlay without Google credentials");
    }
  }
  for (const [service, prefix] of [["api", "watch-api"], ["worker", "watch-api"], ["bootstrap", "watch-api"], ["web", "watch-web"], ["migrate", "watch-migrate"]]) {
    if (config.services[service]?.image !== `${prefix}:${approval.releaseSha}`) throw new Error("Production image differs from approved release SHA");
  }
  if (config.services["reverse-proxy"]?.environment.APP_BASE_URL !== approval.appBaseUrl
    || config.services.api.environment.RELEASE_TAG !== approval.releaseSha
    || config.services.api.environment.WATCH_PRODUCTION_APPROVAL_FILE !== "/run/production-approval.json") throw new Error("Deployment differs from approved origin/release");
  if (env.BACKUP_DIRECTORY !== approval.infrastructure.backupDirectory || env.BACKUP_KEY_FILE !== approval.infrastructure.backupKeyFile) {
    throw new Error("Backup environment differs from approved destination/key path");
  }
  await verifyBackup(approval.infrastructure.backupDirectory, approval.infrastructure.backupKeyFile);
}
