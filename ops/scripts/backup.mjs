import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, open, stat, readdir, rename, unlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { spawnCompose, compose, postgresCommand, completion, root, withDeploymentLock } from "./compose.mjs";

const magic = Buffer.from("WATCHBK1");
const headerSize = magic.length + 12;

export async function encryptBackup(source, file, key) {
  const header = Buffer.concat([magic, randomBytes(12)]);
  const cipher = createCipheriv("aes-256-gcm", key, header.subarray(magic.length));
  cipher.setAAD(header);
  async function* encrypted() {
    yield header;
    for await (const chunk of source) yield cipher.update(chunk);
    yield cipher.final();
    yield cipher.getAuthTag();
  }
  await pipeline(Readable.from(encrypted()), createWriteStream(file, { flags: "wx", mode: 0o600 }));
  const handle = await open(file, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function decryptBackup(file, key, destination) {
  const handle = await open(file, "r");
  let header, tag, size;
  try {
    size = (await handle.stat()).size;
    if (size <= headerSize + 16) throw new Error("Invalid encrypted backup");
    header = Buffer.alloc(headerSize); tag = Buffer.alloc(16);
    await handle.read(header, 0, headerSize, 0);
    await handle.read(tag, 0, 16, size - 16);
    if (!header.subarray(0, magic.length).equals(magic)) throw new Error("Unknown backup format");
  } finally { await handle.close(); }
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(magic.length));
  decipher.setAAD(header); decipher.setAuthTag(tag);
  await pipeline(createReadStream(file, { start: headerSize, end: size - 17 }), decipher, destination);
}

export async function authenticateBackup(file, key) {
  await decryptBackup(file, key, new Writable({ write(_chunk, _encoding, done) { done(); } }));
}

function dateFromName(name) {
  const match = /^watch-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[a-f0-9-]{36}\.enc$/.exec(name);
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}
export function retainedBackups(names) {
  const entries = names.map((name) => ({ name, date: dateFromName(name) })).filter((entry) => entry.date).sort((a, b) => b.date - a.date);
  const days = new Set(), weeks = new Set(), keep = new Set();
  for (const { name, date } of entries) {
    const day = date.toISOString().slice(0, 10);
    const monday = new Date(date); monday.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    const week = monday.toISOString().slice(0, 10);
    if (days.size < 14 && !days.has(day)) { days.add(day); keep.add(name); }
    if (weeks.size < 4 && !weeks.has(week)) { weeks.add(week); keep.add(name); }
  }
  return keep;
}

export async function liveDatabaseName(run = compose) {
  const info = JSON.parse(await run(["run", "--rm", "--no-deps", "api", "node", "apps/api/dist/operations/cli.js", "database-name"]));
  if (!/^(watch|watch_restore_[a-z0-9_]+)$/.test(info.database)) throw new Error("Unsupported deployment database name");
  return info.database;
}
export async function createBackup(directory, key, spawnDump = async () => spawnCompose(postgresCommand("pg_dump", ["--format=custom", "--no-acl"], await liveDatabaseName()), { stdio: ["ignore", "pipe", "pipe"] })) {
  const lock = resolve(directory, ".watch-backup.lock");
  const handle = await open(lock, "wx", 0o600);
  const name = `watch-${new Date().toISOString().replaceAll(":", "-").replace(".", "-")}-${randomUUID()}.enc`;
  const final = resolve(directory, name), partial = `${final}.partial`;
  let child;
  try {
    child = await spawnDump();
    child.stderr.resume();
    const done = completion(child); void done.catch(() => {});
    await encryptBackup(child.stdout, partial, key);
    await done;
    await authenticateBackup(partial, key);
    await rename(partial, final);
    // Retention runs only after a completed, authenticated new backup.
    const names = await readdir(directory);
    const keep = retainedBackups(names);
    for (const old of names) if (dateFromName(old) && !keep.has(old)) await unlink(resolve(directory, old));
    return final;
  } catch (error) {
    child?.kill();
    await unlink(partial).catch(() => {});
    throw error;
  } finally { await handle.close(); await unlink(lock); }
}

export async function restoreBackup(file, key, database, run = compose,
  spawnRestore = (args) => spawnCompose(args, { stdio: ["pipe", "pipe", "pipe"] })) {
  if (!/^watch_restore_[a-z0-9_]{1,40}$/.test(database)) throw new Error("Target must be a NEW isolated watch_restore_ database; production overwrite is forbidden");
  // Authenticate before creating a database or allowing plaintext to reach pg_restore.
  await authenticateBackup(file, key);
  await run(postgresCommand("psql", ["-v", "ON_ERROR_STOP=1"], "postgres"),
    `CREATE DATABASE "${database}" OWNER watch_migrator;\nREVOKE ALL ON DATABASE "${database}" FROM PUBLIC;\nGRANT CONNECT ON DATABASE "${database}" TO watch_app;\n`);
  const child = spawnRestore(postgresCommand("pg_restore", ["--no-owner", "--no-acl", "--role=watch_migrator", "--exit-on-error", "--single-transaction"], database));
  child.stdout.resume(); child.stderr.resume();
  const done = completion(child); void done.catch(() => {});
  try { await decryptBackup(file, key, child.stdin); await done; }
  catch (error) { child.kill(); throw error; }
  await run(postgresCommand("psql", ["-v", "ON_ERROR_STOP=1"], database), await readFile(resolve(root, "ops/docker/restore-grants.sql"), "utf8"));
  await run(["run", "--rm", "--no-deps", "-e", `WATCH_RESTORE_DATABASE=${database}`, "api", "node", "apps/api/dist/operations/cli.js", "verify-restore"]);
  return { status: "ok", database, verified: true };
}

async function loadKey() {
  const file = process.env.BACKUP_KEY_FILE;
  if (!file || !isAbsolute(file)) throw new Error("BACKUP_KEY_FILE must be an absolute path outside the backup destination");
  const value = (await readFile(file, "utf8")).trim();
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value) throw new Error("Backup key must encode exactly 32 random bytes as unpadded base64url");
  if (process.platform !== "win32" && ((await stat(file)).mode & 0o077)) throw new Error("Backup key permissions must be owner-only");
  return { key, file: await realpath(file) };
}
function inside(parent, file) {
  const path = relative(parent, file);
  return path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path));
}
async function backupDestination(keyFile) {
  const configured = process.env.BACKUP_DIRECTORY;
  if (!configured || !isAbsolute(configured)) throw new Error("BACKUP_DIRECTORY must be an existing separately mounted backup destination");
  const directory = await realpath(configured);
  if (inside(root, directory) || inside(directory, keyFile)) throw new Error("Backup destination must be outside the checkout and separate from its encryption key");
  const current = await stat(directory), parent = await stat(dirname(directory));
  if (!current.isDirectory() || current.dev === parent.dev) throw new Error("Backup destination is not a mounted filesystem; aborting to avoid writing to host disk");
  return directory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, file, database] = process.argv.slice(2);
  try {
    const { key, file: keyFile } = await loadKey();
    if (command === "backup") console.log(await withDeploymentLock(async () => JSON.stringify({ status: "ok", file: await createBackup(await backupDestination(keyFile), key) })));
    else if (command === "authenticate" && file) { await authenticateBackup(file, key); console.log(JSON.stringify({ status: "ok", authenticated: true })); }
    else if (command === "restore" && file && database) console.log(await withDeploymentLock(async () => JSON.stringify(await restoreBackup(file, key, database))));
    else if (command === "verify-latest") {
      await withDeploymentLock(async () => {
        const directory = await backupDestination(keyFile);
        const names = (await readdir(directory)).filter((name) => dateFromName(name)).sort((a, b) => dateFromName(b) - dateFromName(a));
        if (!names[0]) throw new Error("No completed backup available for restore verification");
        const target = `watch_restore_check_${randomBytes(8).toString("hex")}`;
        const result = await restoreBackup(resolve(directory, names[0]), key, target);
        // Drop only this randomly named verification DB after all checks succeeded.
        await compose(postgresCommand("psql", ["-v", "ON_ERROR_STOP=1"], "postgres"), `DROP DATABASE "${target}";\n`);
        console.log(JSON.stringify({ ...result, temporaryDatabaseRemoved: true }));
      });
    }
    else throw new Error("Usage: backup.mjs backup|authenticate FILE|restore FILE watch_restore_NAME|verify-latest");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
