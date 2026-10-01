import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rmdir } from "node:fs/promises";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export async function withDeploymentLock(work) {
  const lock = resolve(root, "ops/deployment.lock");
  await mkdir(lock);
  try { return await work(); } finally { await rmdir(lock); }
}
export function composeArgs(configFile = process.env.WATCH_CONFIG_FILE || "ops/docker/production.env") {
  const file = resolve(root, configFile);
  return ["compose", "--env-file", file, "-f", resolve(root, "ops/docker/compose.production.yml")];
}
export function composeEnv(configFile = process.env.WATCH_CONFIG_FILE || "ops/docker/production.env") {
  return { ...process.env, WATCH_CONFIG_FILE: resolve(root, configFile) };
}
export function spawnCompose(args, options = {}) {
  return spawn("docker", [...composeArgs(), ...args], { cwd: root, env: composeEnv(), ...options });
}
export function completion(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", () => reject(new Error("Cannot start operational command")));
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`Operational command failed (exit ${code})`)));
  });
}
export async function compose(args, input) {
  const child = spawnCompose(args, { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  // Docker/psql stderr can contain connection strings. Report stages and exit codes only.
  child.stderr.resume();
  const done = completion(child);
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  await done;
  return output;
}
export function postgresCommand(program, args, database = "watch") {
  if (!["watch", "postgres"].includes(database) && !/^watch_restore_[a-z0-9_]+$/.test(database)) throw new Error("Invalid isolated restore database");
  // Fixed shell code only; all external values are positional arguments.
  return ["exec", "-T", "postgres", "sh", "-eu", "-c",
    'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec "$@"', "watch-postgres", program,
    "--host=127.0.0.1", "--username=watch_admin", `--dbname=${database}`, ...args];
}
export async function criticalServices() {
  const config = JSON.parse(await compose(["config", "--format", "json"]));
  for (const [name, service] of Object.entries(config.services)) {
    if (name !== "reverse-proxy" && service.ports?.length) throw new Error("Internal service publishes a port");
  }
  const rows = (await compose(["ps", "--all", "--format", "json"])).trim().split("\n").filter(Boolean).flatMap((line) => JSON.parse(line));
  for (const service of ["postgres", "api", "web", "worker", "reverse-proxy"]) {
    const instances = rows.filter((row) => row.Service === service);
    if (instances.length !== 1 || instances[0].State !== "running"
      || (service !== "reverse-proxy" && instances[0].Health !== "healthy")) throw new Error(`Critical service ${service} is unhealthy`);
  }
  for (const service of ["migrate", "bootstrap"]) {
    const job = rows.find((row) => row.Service === service);
    if (!job || job.State !== "exited" || job.ExitCode !== 0) throw new Error(`Required job ${service} did not succeed`);
  }
  return config.services["reverse-proxy"].environment.APP_BASE_URL;
}
