import { pathToFileURL } from "node:url";
import { compose, criticalServices, postgresCommand, withDeploymentLock } from "./compose.mjs";
import { productionSmoke } from "./smoke.mjs";
import { verifyLaunchInputs, verifyReleaseSource } from "./launch.mjs";

/** The proxy remains closed after any failed gate; an operator must repair/retry. */
export async function deploy(mode, run = compose, smoke = productionSmoke, services = criticalServices, preflight = verifyLaunchInputs, source = verifyReleaseSource) {
  if (!["prepare", "stage", "fresh", "upgrade"].includes(mode)) throw new Error("Usage: node ops/scripts/deploy.mjs prepare|stage|fresh|upgrade");
  const closedPreparation = mode === "prepare" || mode === "stage" || mode === "fresh";
  const previousClosedAcceptance = process.env.WATCH_CLOSED_ACCEPTANCE;
  if (closedPreparation) process.env.WATCH_CLOSED_ACCEPTANCE = "1";
  // An explicit blank also overrides a stale closed marker in Compose --env-file.
  else process.env.WATCH_CLOSED_ACCEPTANCE = "";
  try {
    const config = JSON.parse(await run(["config", "--format", "json"]));
    if (!/^watch-api:[a-f0-9]{40}$/.test(config.services.api.image)) throw new Error("RELEASE_TAG must be the reviewed commit SHA");
    const existing = (await run(["ps", "--all", "--format", "json"])).trim();
    if (["prepare","fresh"].includes(mode) && existing) throw new Error("Fresh install requires a new Compose project/volume; use stage to resume closed preparation or upgrade after final approval");
    await source(config.services.api.image.slice("watch-api:".length));
    await run(["build", "migrate", "api", "web"]);
    try {
      // A failed final-approval check must not leave traffic open on an existing project.
      // Source identity is checked above, before this deliberate safety stop.
      await run(["stop", "--timeout", "120", "reverse-proxy", "worker", "api", "web"]);
      await preflight(config, run);
      if ((await run(["ps", "--status", "running", "--format", "json", "api", "worker", "web", "reverse-proxy"])).trim()) throw new Error("DB writers or traffic could not be quiesced");
      await run(["up", "-d", "--no-deps", "--wait", "--wait-timeout", "120", "postgres"]);
      if (["prepare","fresh"].includes(mode)) {
        const count = await run(postgresCommand("psql", ["-At", "-v", "ON_ERROR_STOP=1", "-c", "SELECT count(*) FROM pg_tables WHERE schemaname='public'"]));
        if (count.trim() !== "0") throw new Error("Fresh install found existing application data; use upgrade");
      }
      await run(["up", "--no-deps", "--force-recreate", "--abort-on-container-exit", "--exit-code-from", "migrate", "migrate"]);
      await run(["up", "--no-deps", "--force-recreate", "--abort-on-container-exit", "--exit-code-from", "bootstrap", "bootstrap"]);
      // Opening stock is an explicit reviewed import after legal/currency bootstrap.
      // Leave every application writer and the proxy stopped until upgrade verifies it.
      if (mode === "prepare" || mode === "fresh") return;
      await run(["up", "-d", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "120", "api", "web", "worker"]);
      await run(["exec", "-T", "api", "runtime-secrets", "node", "apps/api/dist/operations/cli.js", "verify"]);
      if (mode === "stage") return; // Internal services only; keep the public proxy stopped.
      await run(["up", "-d", "--no-deps", "--force-recreate", "reverse-proxy"]);
      const origin = await services();
      // Caddy may still be acquiring its first certificate; bounded retry, no insecure TLS fallback.
      let passed = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        try { await smoke(origin); passed = true; break; }
        catch { if (attempt < 11) await new Promise((done) => setTimeout(done, 5000)); }
      }
      if (!passed) throw new Error("Public production smoke failed");
    } catch (error) {
      try { await run(["stop", "reverse-proxy"]); }
      finally { await run(["stop", "--timeout", "120", "worker", "api", "web"]); }
      throw error;
    }
  } finally {
    if (previousClosedAcceptance === undefined) delete process.env.WATCH_CLOSED_ACCEPTANCE;
    else process.env.WATCH_CLOSED_ACCEPTANCE = previousClosedAcceptance;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await withDeploymentLock(() => deploy(process.argv[2]));
    console.log(JSON.stringify({ status: "ok", mode: process.argv[2] }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
