import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { deploy } from "./deploy.mjs";
import { productionSmoke } from "./smoke.mjs";
import { encryptBackup, decryptBackup, authenticateBackup, retainedBackups, createBackup, restoreBackup, liveDatabaseName } from "./backup.mjs";

const config = { services: { api: { image: `watch-api:${"a".repeat(40)}` } } };
test("backup follows the configured database after a restored database is promoted", async () => {
  assert.equal(await liveDatabaseName(async () => '{"database":"watch_restore_promoted"}'), "watch_restore_promoted");
  await assert.rejects(liveDatabaseName(async () => '{"database":"postgres"}'));
});
function runner(failure, mode = "upgrade") {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (failure?.(args)) throw new Error("Injected gate failure");
    if (args[0] === "config") return JSON.stringify(config);
    if (args[0] === "ps") return "";
    if (args.includes("SELECT count(*) FROM pg_tables WHERE schemaname='public'")) return "0\n";
    return "";
  };
  return { calls, run, mode };
}

test("upgrade quiesces writers, recreates migration/bootstrap jobs and verifies before opening traffic", async () => {
  const { calls, run } = runner();
  const smoke = [], services = async () => "https://public.example.com";
  await deploy("upgrade", run, async (url) => smoke.push(url), services);
  const index = (predicate) => calls.findIndex(predicate);
  assert.ok(index((a) => a[0] === "stop" && a.includes("api")) < index((a) => a.includes("--exit-code-from")));
  assert.ok(index((a) => a.at(-1) === "migrate" && a.includes("--force-recreate")) < index((a) => a.at(-1) === "bootstrap"));
  assert.ok(index((a) => a.at(-1) === "verify") < index((a) => a[0] === "up" && a.at(-1) === "reverse-proxy"));
  assert.deepEqual(smoke, ["https://public.example.com"]);
});

for (const gate of ["migrate", "bootstrap", "verify", "worker"]) test(`failed ${gate} gate keeps traffic closed`, async () => {
  const { calls, run } = runner((a) => gate === "worker" ? a[0] === "up" && a.at(-1) === "worker" : a.at(-1) === gate && (a.includes("--exit-code-from") || gate === "verify"));
  await assert.rejects(deploy("upgrade", run, async () => {}, async () => "https://public.example.com"));
  assert.equal(calls.some((a) => a[0] === "up" && a.at(-1) === "reverse-proxy"), false);
  assert.ok(calls.at(-1).includes("stop"));
});
test("fresh install refuses a retained database and an existing project", async () => {
  const { calls, run } = runner();
  await assert.rejects(deploy("fresh", async (args) => args.includes("SELECT count(*) FROM pg_tables WHERE schemaname='public'") ? "4\n" : run(args)));
  assert.equal(calls.some((args) => args.includes("--exit-code-from")), false);
  await assert.rejects(deploy("fresh", async (args) => args[0] === "ps" ? '{"Service":"postgres"}' : run(args)), /new Compose project/);
});
test("service failure after proxy start closes proxy and all writers", async () => {
  const { calls, run } = runner();
  await assert.rejects(deploy("upgrade", run, async () => {}, async () => { throw new Error("unhealthy"); }));
  assert.deepEqual(calls.at(-2), ["stop", "reverse-proxy"]);
  assert.ok(calls.at(-1).includes("worker"));
});
test("partially failed proxy start still closes proxy and all writers", async () => {
  const { calls, run } = runner((args) => args[0] === "up" && args.at(-1) === "reverse-proxy");
  await assert.rejects(deploy("upgrade", run));
  assert.deepEqual(calls.at(-2), ["stop", "reverse-proxy"]);
  assert.ok(calls.at(-1).includes("worker"));
});

const headers = {
  "strict-transport-security": "max-age=31536000", "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer", "content-security-policy": "default-src 'self'; object-src 'none'"
};
function proxyFetch(override = () => ({})) {
  return async (url) => {
    const path = url.pathname;
    const status = path === "/api/v1/auth/session" || path.startsWith("/api/v1/legal/") ? 401 : 200;
    const body = path === "/" ? "<!doctype html><html></html>" : JSON.stringify({ status: path === "/health" ? "ok" : "ready" });
    return new Response(body, { status, headers, ...override(path) });
  };
}
test("public smoke hits exact health/ready through one HTTPS origin and verifies auth/header gates", async () => {
  const paths = [];
  const fetcher = proxyFetch();
  assert.deepEqual(await productionSmoke("https://public.example.com", async (url, options) => {
    assert.equal(url.origin, "https://public.example.com"); paths.push(url.pathname);
    assert.equal(options.redirect, "manual"); return fetcher(url);
  }), { status: "ok", checks: 7 });
  assert.ok(paths.includes("/health") && paths.includes("/ready"));
  await assert.rejects(productionSmoke("http://public.example.com"), /HTTPS/);
  await assert.rejects(productionSmoke("https://public.example.com", proxyFetch((path) => path === "/ready" ? { status: 503 } : {})), /503/);
  await assert.rejects(productionSmoke("https://public.example.com", proxyFetch(() => ({ headers: {} }))), /security headers/);
  await assert.rejects(productionSmoke("https://public.example.com", proxyFetch(() => ({ headers: { ...headers, "access-control-allow-origin": "*" } }))), /CORS/);
});

test("backup authenticates header/ciphertext/tag, detects truncation and refuses wrong keys before DB writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "watch-crypto-"));
  try {
    const key = randomBytes(32), file = join(dir, "backup.enc"), plaintext = Buffer.from("PGDMP sensitive database data".repeat(10000));
    await encryptBackup(Readable.from([plaintext]), file, key);
    assert.equal((await readFile(file)).includes(plaintext.subarray(0, 40)), false);
    const restored = [];
    await decryptBackup(file, key, new Writable({ write(chunk, _encoding, done) { restored.push(chunk); done(); } }));
    assert.deepEqual(Buffer.concat(restored), plaintext);
    await assert.rejects(authenticateBackup(file, randomBytes(32)));
    const original = await readFile(file);
    for (const offset of [9, 30, original.length - 1]) {
      const damaged = Buffer.from(original); damaged[offset] ^= 1; await writeFile(file, damaged);
      await assert.rejects(authenticateBackup(file, key));
    }
    await writeFile(file, original.subarray(0, 10));
    await assert.rejects(authenticateBackup(file, key));
    let writes = 0;
    await assert.rejects(restoreBackup(file, key, "watch_restore_test", async () => { writes++; }));
    assert.equal(writes, 0);
    await assert.rejects(restoreBackup(file, key, "watch"), /production overwrite/);
  } finally { await rm(dir, { recursive: true }); }
});
test("retention keeps 14 daily and 4 weekly points, ignores unrelated files", () => {
  const files = Array.from({ length: 60 }, (_, i) => {
    const date = new Date("2026-10-01T01:00:00.000Z"); date.setUTCDate(date.getUTCDate() - i);
    return `watch-${date.toISOString().replaceAll(":", "-").replace(".", "-")}-${randomUUID()}.enc`;
  });
  const keep = retainedBackups([...files, "do-not-delete.txt", "unfinished.enc.partial"]);
  for (const file of files.slice(0, 14)) assert.ok(keep.has(file));
  assert.ok(keep.size >= 14 && keep.size <= 18);
  assert.ok([...keep].some((file) => file.includes("2026-09-13")));
  assert.equal(keep.has(files.at(-1)), false);
});
test("failed pg_dump leaves no completed/partial archive and cannot prune previous backups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "watch-failed-backup-"));
  try {
    const old = `watch-2026-01-01T01-00-00-000Z-${randomUUID()}.enc`;
    await writeFile(join(dir, old), "retained until successful backup");
    await assert.rejects(createBackup(dir, randomBytes(32), () => spawn(process.execPath, ["-e", "process.stdout.write('partial dump');process.exitCode=1"])), /failed/);
    assert.deepEqual(await readdir(dir), [old]);
  } finally { await rm(dir, { recursive: true }); }
});
