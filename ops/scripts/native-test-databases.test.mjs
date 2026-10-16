import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeTestDatabaseConfiguration, prepareNativeTestDatabases } from "./prepare-native-test-databases.mjs";
const env = { WATCH_NATIVE_TEST_ADMIN_URL: "postgresql://test@127.0.0.1:55450/postgres",
  WATCH_T46_DATABASE_URL: "postgresql://test@127.0.0.1:55450/watch_t46",
  WATCH_T47_DATABASE_URL: "postgresql://test@127.0.0.1:55450/watch_t47",
  WATCH_T48_DATABASE_URL: "postgresql://test@127.0.0.1:55450/watch_t48" };

test("native CI database setup rejects missing, remote, non-disposable and mismatched URLs before connecting", async () => {
  for (const invalid of [{}, { ...env, WATCH_NATIVE_TEST_ADMIN_URL: "postgresql://test@db.company.org/postgres" },
    { ...env, WATCH_NATIVE_TEST_ADMIN_URL: "postgresql://test@127.0.0.1:55450/watch" },
    { ...env, WATCH_T46_DATABASE_URL: undefined }, { ...env, WATCH_T48_DATABASE_URL: env.WATCH_NATIVE_TEST_ADMIN_URL },
    { ...env, WATCH_T47_DATABASE_URL: "postgresql://test@127.0.0.1:5432/watch_t47" }]) {
    await assert.rejects(prepareNativeTestDatabases(invalid, () => assert.fail("must validate before connecting")));
  }
  assert.deepEqual(nativeTestDatabaseConfiguration(env).names, ["watch_t46", "watch_t47", "watch_t48"]);
});

test("native CI database setup creates only missing fixed databases and preserves existing data on replay", async () => {
  const databases = new Set(["watch_t47"]), creates = []; let closed = 0;
  const pool = { query: async (sql, args) => {
    if (sql.startsWith("SELECT")) return { rowCount: databases.has(args[0]) ? 1 : 0 };
    assert.match(sql, /^CREATE DATABASE "watch_t4[678]"$/);
    const name = sql.split('"')[1]; databases.add(name); creates.push(name); return {};
  }, end: async () => { closed++; } };
  assert.deepEqual(await prepareNativeTestDatabases(env, () => pool), ["watch_t46", "watch_t48"]);
  assert.deepEqual(await prepareNativeTestDatabases(env, () => pool), []);
  assert.deepEqual(creates, ["watch_t46", "watch_t48"]); assert.equal(closed, 2);
});

test("native CI database setup releases its connection on SQL failure", async () => {
  let closed = false;
  await assert.rejects(prepareNativeTestDatabases(env, () => ({ query: async () => { throw new Error("SQL failure"); }, end: async () => { closed = true; } })), /SQL failure/);
  assert.equal(closed, true);
});
