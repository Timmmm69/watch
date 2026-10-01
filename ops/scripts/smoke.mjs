import { pathToFileURL } from "node:url";
import { criticalServices } from "./compose.mjs";

export async function productionSmoke(origin, fetcher = fetch) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Smoke requires the public HTTPS origin");
  const request = async (path, status) => {
    const response = await fetcher(new URL(path, url), { redirect: "manual", signal: AbortSignal.timeout(15000) });
    if (response.status !== status) throw new Error(`Public ${path} returned ${response.status}, expected ${status}`);
    if (response.headers.get("access-control-allow-origin")) throw new Error("Unexpected CORS header");
    if (!/max-age=[1-9][0-9]*/.test(response.headers.get("strict-transport-security") || "")
      || response.headers.get("x-content-type-options") !== "nosniff"
      || response.headers.get("referrer-policy") !== "no-referrer"
      || !response.headers.get("content-security-policy")?.includes("object-src 'none'")) throw new Error(`Public ${path} lacks security headers`);
    return response;
  };
  if ((await (await request("/health", 200)).json()).status !== "ok") throw new Error("Public /health did not reach Fastify");
  if ((await (await request("/ready", 200)).json()).status !== "ready") throw new Error("Public /ready did not reach Fastify");
  if (!(await (await request("/", 200)).text()).toLowerCase().includes("<html")) throw new Error("Web did not return HTML");
  await request("/api/v1/auth/session", 401);
  // Installed legal routes require a session; artifacts are verified by bootstrap/readiness.
  for (const type of ["PARTNER_TERMS", "SALES_TERMS", "PRIVACY"]) await request(`/api/v1/legal/${type}/current`, 401);
  return { status: "ok", checks: 7 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const origin = await criticalServices();
    const result = await productionSmoke(origin);
    console.log(JSON.stringify({ ...result, services: "healthy" }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
