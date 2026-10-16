import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { composeArgs } from "../scripts/compose.mjs";

test("native Compose removes Google secrets and routes the config overlay", () => {
  const directory=mkdtempSync(join(tmpdir(),"watch-native-compose-"));
  const file=join(directory,"native.env");
  try {
    writeFileSync(file,readFileSync("ops/docker/production.env.example","utf8").replace("INVENTORY_PROVIDER=google_sheets","INVENTORY_PROVIDER=native"));
    const args=composeArgs(file);
    assert.ok(args.some(arg=>arg.endsWith("compose.native.yml")));
    const result=spawnSync("docker",[...args,"config","--format","json"],{
      encoding:"utf8",env:{...process.env,WATCH_CONFIG_FILE:join(process.cwd(),"ops/docker/production.env.example")},
    });
    assert.equal(result.status,0,result.stderr);
    const config=JSON.parse(result.stdout);
    for(const name of ["api","worker","bootstrap"]) {
      assert.equal(config.services[name].secrets.some(s=>s.source==="google_service_account"),false);
      assert.equal(config.services[name].environment.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64_FILE,"");
    }
    assert.equal(config.secrets.google_service_account,undefined);
  } finally {unlinkSync(file);rmdirSync(directory);}
});

test("direct closed-acceptance Compose command uses its selected config as the service env file", () => {
  const directory = mkdtempSync(join(tmpdir(), "watch-closed-compose-"));
  const file = join(directory, "closed.env");
  try {
    writeFileSync(file, readFileSync("ops/docker/production.env.example", "utf8")
      .replace("SUPPORT_CONTACT=replace-with-reviewed-support-contact", "SUPPORT_CONTACT=@closed_acceptance_support") + "\nWATCH_CLOSED_ACCEPTANCE=1\n");
    const result = spawnSync("docker", ["compose", "--env-file", file, "-f", "ops/docker/compose.production.yml", "-f", "ops/docker/compose.native.yml", "config", "--format", "json"], {
      encoding: "utf8", env: { ...process.env, WATCH_CONFIG_FILE: file, WATCH_CLOSED_ACCEPTANCE: "1" }
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.services.api.environment.SUPPORT_CONTACT, "@closed_acceptance_support");
    assert.equal(config.services.api.environment.WATCH_CLOSED_ACCEPTANCE, "1");
    assert.equal(config.services["reverse-proxy"].environment.WATCH_CLOSED_ACCEPTANCE, "1");
    assert.deepEqual(config.services["reverse-proxy"].entrypoint, ["/bin/sh", "/usr/local/bin/watch-proxy-entrypoint.sh"]);
    // Upgrade must override even a closed marker stored in the selected env file.
    const final = spawnSync("docker", ["compose", "--env-file", file, "-f", "ops/docker/compose.production.yml", "-f", "ops/docker/compose.native.yml", "config", "--format", "json"], {
      encoding: "utf8", env: { ...process.env, WATCH_CONFIG_FILE: file, WATCH_CLOSED_ACCEPTANCE: "" }
    });
    assert.equal(final.status, 0, final.stderr);
    const opened = JSON.parse(final.stdout);
    assert.equal(opened.services.api.environment.WATCH_CLOSED_ACCEPTANCE, "");
    assert.equal(opened.services["reverse-proxy"].environment.WATCH_CLOSED_ACCEPTANCE, "");
  } finally { unlinkSync(file); rmdirSync(directory); }
});

test("production Compose isolates services, secrets and migration ordering", () => {
  const result = spawnSync("docker", ["compose", "--env-file", "ops/docker/production.env.example", "-f", "ops/docker/compose.production.yml", "config", "--format", "json"], {
    encoding: "utf8", env: { ...process.env, WATCH_CONFIG_FILE: "production.env.example" }
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(config.services).sort(), ["api", "bootstrap", "migrate", "postgres", "reverse-proxy", "web", "worker"]);
  for (const [name, service] of Object.entries(config.services)) {
    if (name !== "reverse-proxy") assert.equal(service.ports, undefined, `${name} must not publish ports`);
  }
  assert.deepEqual(config.services["reverse-proxy"].ports.map((p) => p.target).sort((a, b) => a - b), [80, 443]);
  assert.equal(config.networks.database.internal, true);
  assert.equal(config.networks.proxy.internal, true);
  assert.equal(config.services["reverse-proxy"].networks.database, undefined);
  assert.equal(config.services.web.networks.database, undefined);
  assert.equal(config.services.worker.networks.proxy, undefined);
  const proxyIp = config.services["reverse-proxy"].networks.proxy.ipv4_address;
  assert.equal(config.services.api.environment.API_TRUSTED_PROXY_IP, proxyIp);
  assert.equal(config.services.api.environment.WATCH_PRODUCTION_APPROVAL_FILE, "/run/production-approval.json");
  for (const name of ["api", "worker", "bootstrap"]) {
    const mount = config.services[name].volumes.find((volume) => volume.target === "/run/production-approval.json");
    assert.equal(mount.type, "bind"); assert.equal(mount.read_only, true);
  }
  for (const name of ["api", "web", "worker"]) {
    assert.equal(config.services[name].depends_on.migrate.condition, "service_completed_successfully");
    assert.equal(config.services[name].depends_on.bootstrap.condition, "service_completed_successfully");
    assert.equal(config.services[name].read_only, true);
    assert.equal(config.services[name].user, "1000:1000");
  }
  assert.equal(config.services.migrate.restart, "no");
  assert.equal(config.services.bootstrap.restart, "no");
  assert.equal(config.services.bootstrap.depends_on.bootstrap, undefined);
  assert.ok(config.services.worker.healthcheck);
  for (const service of Object.values(config.services)) {
    assert.equal(service.logging.options["max-size"], "10m");
    assert.equal(service.logging.options["max-file"], "3");
  }
  assert.deepEqual(config.services.migrate.secrets.map((s) => s.source), ["migrate_database_url"]);
  assert.equal(config.services.web.secrets, undefined);
  assert.equal(config.services.api.secrets.some((s) => s.source === "migrate_database_url" || s.source === "postgres_password"), false);
  for (const field of ["DATABASE_URL", "TELEGRAM_BOT_TOKEN", "CSRF_SECRET", "OBJECT_STORAGE_SECRET_ACCESS_KEY"]) {
    assert.equal(config.services.api.environment[field], undefined);
    assert.ok(config.services.api.environment[`${field}_FILE`]);
  }
});

test("proxy preserves API paths and accepts the full multipart envelope", () => {
  const caddy = readFileSync("ops/docker/Caddyfile", "utf8");
  assert.match(caddy, /@api path \/api\/\* \/health \/ready\n/);
  assert.doesNotMatch(caddy, /handle_path|\/health\*|\/ready\*|Access-Control-Allow-Origin/);
  assert.ok(Number(caddy.match(/max_size (\d+)/)[1]) >= 57_671_680);
  assert.match(caddy, /X-Forwarded-For \{remote_host\}/);
  for (const name of ["Strict-Transport-Security", "Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy"]) assert.ok(caddy.includes(name));
});

test("runtime secrets are read as data and empty/conflicting files fail closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "watch-secrets-test-"));
  const secretFile = join(directory, "secret");
  const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "sh";
  const env = { ...process.env, DATABASE_URL_FILE: secretFile.replaceAll("\\", "/") };
  delete env.DATABASE_URL;
  const run = (extra = {}) => spawnSync(shell, ["ops/docker/runtime-secrets.sh", process.execPath.replaceAll("\\", "/"), "-e",
    "if(process.env.DATABASE_URL!==process.env.EXPECTED_SECRET) process.exit(1)"], { env: { ...env, ...extra }, encoding: "utf8" });
  try {
    const value = "literal-$(printf injected)-`printf injected`-'quote'-$HOME";
    writeFileSync(secretFile, value + "\n");
    assert.equal(run({ EXPECTED_SECRET: value }).status, 0);
    assert.equal(run({EXPECTED_SECRET:value,INVENTORY_PROVIDER:"native",GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64_FILE:"/missing-unused-google-secret"}).status,0);
    const conflict = run({ DATABASE_URL: "other-secret" });
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /not both/);
    assert.ok(!conflict.stderr.includes(value));
    writeFileSync(secretFile, "");
    const empty = run();
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /is empty/);
  } finally {
    unlinkSync(secretFile);
    rmdirSync(directory);
  }
});

test("public proxy entrypoint refuses closed acceptance before running any listener", () => {
  const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "sh";
  const run = (marker) => spawnSync(shell, ["ops/docker/proxy-entrypoint.sh", process.execPath.replaceAll("\\", "/"), "-p", "12345"], {
    encoding: "utf8", env: { ...process.env, WATCH_CLOSED_ACCEPTANCE: marker }
  });
  for (const marker of ["1", "true"]) {
    const blocked = run(marker); assert.equal(blocked.status, 1); assert.match(blocked.stderr, /disabled during closed acceptance/);
    assert.doesNotMatch(blocked.stdout, /12345/);
  }
  const final = run(""); assert.equal(final.status, 0); assert.match(final.stdout, /12345/);
});
