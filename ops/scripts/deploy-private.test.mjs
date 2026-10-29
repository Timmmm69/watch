import test from "node:test";
import assert from "node:assert/strict";
import { deployPrivate, verifyPrivateInputs } from "./deploy-private.mjs";

const config = () => ({ services: Object.fromEntries(["api", "worker", "bootstrap"].map(name => [name, {
  environment: { WATCH_PRIVATE_ACCESS: "1", INVENTORY_PROVIDER: "native" }, volumes: [],
}])) });
const runtime = { status: "ok", privateAccess: true, allowedTelegramIds: ["42"] };

test("private preflight requires the explicit overlay and a nonempty runtime allowlist", async () => {
  const previous = process.env.WATCH_CLOSED_ACCEPTANCE;
  process.env.WATCH_CLOSED_ACCEPTANCE = "1";
  try {
    await verifyPrivateInputs(config(), async () => JSON.stringify(runtime));
    await verifyPrivateInputs(config(), async () => JSON.stringify({ ...runtime, publicShop: true, allowedTelegramIds: undefined }));
    for (const changed of [
      { ...runtime, privateAccess: false }, { ...runtime, allowedTelegramIds: [] },
      { ...runtime, productionApprovalSha256: "a".repeat(64) },
    ]) await assert.rejects(verifyPrivateInputs(config(), async () => JSON.stringify(changed)));
    for (const name of ["api", "worker", "bootstrap"]) {
      const broken = config(); delete broken.services[name].environment.WATCH_PRIVATE_ACCESS;
      await assert.rejects(verifyPrivateInputs(broken, async () => JSON.stringify(runtime)));
    }
  } finally {
    if (previous === undefined) delete process.env.WATCH_CLOSED_ACCEPTANCE;
    else process.env.WATCH_CLOSED_ACCEPTANCE = previous;
  }
});

test("private ingress opens only after verified stage and closes on failed public smoke", async () => {
  const calls = [];
  const run = async args => { calls.push(args); return ""; };
  const stage = async mode => { calls.push(["verified", mode]); };
  await deployPrivate("prepare", run, undefined, undefined, stage);
  assert.deepEqual(calls, [["verified", "prepare"]]);
  calls.length = 0;
  await deployPrivate("start", run, async () => {}, async () => "https://private.example", stage);
  assert.equal(calls[0][0], "verified");
  assert.equal(calls[1].at(-1), "reverse-proxy");
  calls.length = 0;
  await assert.rejects(deployPrivate("start", run, async () => {}, async () => { throw new Error("not healthy"); }, stage));
  assert.deepEqual(calls.at(-1), ["stop", "reverse-proxy"]);
});
