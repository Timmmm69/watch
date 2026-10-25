import { pathToFileURL } from "node:url";
import { compose, criticalServices, withDeploymentLock } from "./compose.mjs";
import { deploy } from "./deploy.mjs";
import { productionSmoke } from "./smoke.mjs";

export async function verifyPrivateInputs(config, run = compose) {
  if (process.env.WATCH_CLOSED_ACCEPTANCE !== "1") throw new Error("Private preparation must remain closed");
  for (const name of ["api", "worker", "bootstrap"]) {
    const service = config.services[name];
    if (service?.environment?.WATCH_PRIVATE_ACCESS !== "1" || service.environment.INVENTORY_PROVIDER !== "native"
      || service.environment.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64_FILE
      || service.volumes?.some(volume => volume.target === "/run/production-approval.json")) {
      throw new Error("Explicit native private-access overlay required for every application service");
    }
  }
  const runtime = JSON.parse(await run(["run", "--rm", "--no-deps", "api", "node", "apps/api/dist/operations/cli.js", "config"]));
  if (runtime.status !== "ok" || runtime.privateAccess !== true
    || (runtime.publicShop !== true && !runtime.allowedTelegramIds?.length)
    || runtime.productionApprovalSha256) throw new Error("Runtime requires an explicit public shop or a nonempty Telegram allowlist");
}

export async function deployPrivate(mode, run = compose, smoke = productionSmoke, services = criticalServices, stage = deploy) {
  if (!["prepare", "start"].includes(mode)) throw new Error("Usage: node ops/scripts/deploy-private.mjs prepare|start");
  await stage(mode === "prepare" ? "prepare" : "stage", run, smoke, services, verifyPrivateInputs);
  if (mode === "prepare") return;
  const previous = process.env.WATCH_CLOSED_ACCEPTANCE;
  process.env.WATCH_CLOSED_ACCEPTANCE = "";
  try {
    await run(["up", "-d", "--no-deps", "--force-recreate", "reverse-proxy"]);
    const origin = await services();
    for (let attempt = 0; ; attempt++) {
      try { await smoke(origin); break; }
      catch (error) { if (attempt >= 11) throw error; await new Promise(resolve => setTimeout(resolve, 5000)); }
    }
  } catch (error) {
    await run(["stop", "reverse-proxy"]);
    throw error;
  } finally {
    if (previous === undefined) delete process.env.WATCH_CLOSED_ACCEPTANCE;
    else process.env.WATCH_CLOSED_ACCEPTANCE = previous;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await withDeploymentLock(() => deployPrivate(process.argv[2]));
    console.log(JSON.stringify({ status: "ok", mode: "private", action: process.argv[2] }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
