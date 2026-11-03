import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { rublesToMinor, ownerEditSchema } from "@watch/contracts";
import { dropshipFixture, disposableUrl } from "../../test/dropship-fixture.js";
import { OwnerCatalogService } from "./owner.js";

describe.skipIf(!disposableUrl())(
  "Owner catalog and native ledger through authenticated API",
  () => {
    let f: Awaited<ReturnType<typeof dropshipFixture>>;
    beforeEach(async () => {
      f = await dropshipFixture(3, "", true);
    });
    afterEach(async () => {
      await f?.close();
    });
    const request = () => ({
      operationKey: randomUUID(),
      title: "Новые часы",
      brand: "Casio",
      priceMinor: 19990,
      initialQuantity: 2,
    });
    const call = (method: string, url: string, payload?: object, actor = 2) =>
      f.app.inject({
        method: method as "POST",
        url,
        headers: f.owners[actor]!.headers,
        ...(payload ? { payload } : {}),
      });
    async function create() {
      const r = await call("POST", "/api/v1/admin/shop/products", request());
      expect(r.statusCode, r.body).toBe(200);
      return r.json().id as string;
    }
    async function detail(id: string) {
      return (await call("GET", `/api/v1/admin/products/${id}`)).json();
    }
    const edit = (p: any) => ({
      operationKey: randomUUID(),
      expectedUpdatedAt: p.updatedAt,
      title: p.title,
      brand: p.brand ?? "",
      description: p.description,
      categoryIds: p.categories.map((c: any) => c.id),
      variants: p.variants.map((v: any) => ({
        id: v.id,
        expectedUpdatedAt: v.updatedAt,
        priceMinor: v.priceMinor,
        dropshipPriceMinor: v.dropshipPriceMinor,
        partnerCommissionUnitMinor: v.partnerCommissionUnitMinor,
        supplierSettlementUnitMinor: v.supplierSettlementUnitMinor,
      })),
    });
    it("creates once despite concurrent retries, auto-generates article, keeps unknown cost, forbids non-admin", async () => {
      const body = request(),
        rs = await Promise.all([
          call("POST", "/api/v1/admin/shop/products", body),
          call("POST", "/api/v1/admin/shop/products", body),
        ]);
      expect(rs.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(rs[0]!.json().id).toBe(rs[1]!.json().id);
      const p = await detail(rs[0]!.json().id);
      expect(p.status).toBe("DRAFT");
      expect(p.variants[0].sku).toMatch(/^W-/);
      const state = (
        await call(
          "GET",
          `/api/v1/admin/shop/variants/${p.variants[0].id}/stock`,
        )
      ).json();
      expect(state).toMatchObject({ onHand: 2, reserved: 0, available: 2 });
      expect(state.history).toHaveLength(1);
      expect(
        (
          await f.pool.query(
            "SELECT native_free_value_minor FROM inventory_items WHERE variant_id=$1",
            [p.variants[0].id],
          )
        ).rows[0].native_free_value_minor,
      ).toBeNull();
      expect(
        (await call("POST", "/api/v1/admin/shop/products", request(), 0))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await call("POST", "/api/v1/admin/shop/products", {
            ...body,
            title: "Different",
          })
        ).statusCode,
      ).toBe(400);
    });
    it("saves core and variant atomically, retries lost response, rejects stale edit, never receives stock on price edit", async () => {
      const id = await create(),
        p = await detail(id),
        body = edit(p);
      body.description = "Описание";
      body.variants[0].priceMinor = 9999;
      expect(
        (await call("PATCH", `/api/v1/admin/shop/products/${id}`, body))
          .statusCode,
      ).toBe(200);
      expect(
        (await call("PATCH", `/api/v1/admin/shop/products/${id}`, body))
          .statusCode,
      ).toBe(200);
      const stale = edit(p);
      stale.title = "STALE";
      expect(
        (await call("PATCH", `/api/v1/admin/shop/products/${id}`, stale)).json()
          .error.code,
      ).toBe("EDIT_CONFLICT");
      const fresh = await detail(id);
      expect(fresh.title).toBe("Новые часы");
      expect(fresh.variants[0].priceMinor).toBe(9999);
      const bad = edit(fresh);
      bad.title = "Should roll back";
      bad.variants[0].partnerCommissionUnitMinor = 20000;
      bad.variants[0].supplierSettlementUnitMinor = 0;
      expect(
        (await call("PATCH", `/api/v1/admin/shop/products/${id}`, bad))
          .statusCode,
      ).toBe(400);
      expect((await detail(id)).title).toBe("Новые часы");
      const state = (
        await call(
          "GET",
          `/api/v1/admin/shop/variants/${p.variants[0].id}/stock`,
        )
      ).json();
      expect(state.onHand).toBe(2);
      expect(state.history).toHaveLength(1);
    });
    it("explains publication, permits zero stock publication and hide/restore/archive without deletion", async () => {
      const id = await create();
      const failure = await call(
        "POST",
        `/api/v1/admin/shop/products/${id}/status`,
        { status: "ACTIVE" },
      );
      expect(failure.statusCode).toBe(400);
      expect(failure.json().error.details.issues).toContain(
        "Добавьте описание",
      );
      const r = await call("POST", "/api/v1/admin/shop/test-catalog", {
        confirmed: true,
      });
      expect(r.statusCode, r.body).toBe(200);
      const zero = (
        await f.catalog.listStorefrontProducts({ page: 1, limit: 100 })
      ).items.find((p) => p.title.includes("Presage"))!;
      expect(zero.availability).toBe("OUT_OF_STOCK");
      for (const status of ["DRAFT", "ACTIVE", "ARCHIVED", "DRAFT"]) {
        const r = await call(
          "POST",
          `/api/v1/admin/shop/products/${zero.id}/status`,
          { status },
        );
        expect(r.statusCode, r.body).toBe(200);
      }
      expect((await detail(zero.id)).status).toBe("DRAFT");
    });
    it("receives once and protects counted stock against concurrent receipt; does not write money", async () => {
      const id = await create(),
        p = await detail(id),
        v = p.variants[0].id,
        url = `/api/v1/admin/shop/variants/${v}/stock`;
      const body = {
        operationKey: randomUUID(),
        kind: "RECEIPT",
        quantity: 3,
        expectedOnHand: 2,
        reason: "Поставка",
        occurredAt: new Date().toISOString(),
      };
      expect((await call("POST", url, body)).statusCode).toBe(200);
      expect((await call("POST", url, body)).json().replayed).toBe(true);
      const stale = {
        ...body,
        operationKey: randomUUID(),
        kind: "COUNT",
        quantity: 1,
      };
      expect((await call("POST", url, stale)).json().error.code).toBe(
        "STOCK_CHANGED",
      );
      const counted = {
        ...stale,
        operationKey: randomUUID(),
        expectedOnHand: 5,
      };
      expect((await call("POST", url, counted)).statusCode).toBe(200);
      expect((await call("POST", url, counted)).json().replayed).toBe(true);
      expect((await call("GET", url)).json()).toMatchObject({
        onHand: 1,
        available: 1,
      });
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM orders")).rows[0].n,
      ).toBe(0);
    });
    it("seeds eight test models alongside real catalog once and preserves edited stock", async () => {
      const before = await f.catalog.getProduct(f.product);
      const one = await call("POST", "/api/v1/admin/shop/test-catalog", {
        confirmed: true,
      });
      expect(one.statusCode, one.body).toBe(200);
      const all = await f.catalog.listProducts({ page: 1, limit: 100 });
      expect(all.total).toBe(9);
      expect(all.items.filter((p) => p.title.includes("ТЕСТ"))).toHaveLength(8);
      const demo = all.items.find((p) => p.title.includes("PRX"))!,
        v = demo.variants[0]!.id;
      const body = {
        operationKey: randomUUID(),
        kind: "WRITE_OFF",
        quantity: 1,
        expectedOnHand: 1,
        reason: "Тестовое списание",
        occurredAt: new Date().toISOString(),
      };
      expect(
        (await call("POST", `/api/v1/admin/shop/variants/${v}/stock`, body))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await call("POST", "/api/v1/admin/shop/test-catalog", {
            confirmed: true,
          })
        ).json().replayed,
      ).toBe(true);
      expect((await f.catalog.getProduct(f.product)).title).toBe(before.title);
      expect(
        (await call("GET", `/api/v1/admin/shop/variants/${v}/stock`)).json()
          .onHand,
      ).toBe(0);
      const search = await f.catalog.listProducts({
        page: 1,
        limit: 20,
        q: "DEMO-TISSOT-PRX",
      });
      expect(search.total).toBe(1);
      expect(search.items[0]!.coverUrl).toBeTruthy();
    });
    it("deduplicates actual multipart uploads by retry key and rejects a changed file", async () => {
      const id = await create(),
        key = randomUUID();
      const { readFile } = await import("node:fs/promises");
      const file = await readFile(
        new URL("../../fixtures/demo-catalog/classic.jpg", import.meta.url),
      );
      const upload = (bytes: Buffer) =>
        f.app.inject({
          method: "POST",
          url: `/api/v1/admin/products/${id}/assets/media`,
          headers: {
            ...f.owners[2]!.headers,
            "x-idempotency-key": key,
            "content-type": "multipart/form-data; boundary=OwnerTest",
          },
          payload: Buffer.concat([
            Buffer.from(
              '--OwnerTest\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nSTOREFRONT\r\n--OwnerTest\r\nContent-Disposition: form-data; name="file"; filename="watch.jpg"\r\nContent-Type: image/jpeg\r\n\r\n',
            ),
            bytes,
            Buffer.from("\r\n--OwnerTest--\r\n"),
          ]),
        });
      const one = await upload(file),
        two = await upload(file);
      expect(one.statusCode, one.body).toBe(200);
      expect(two.statusCode, two.body).toBe(200);
      expect(one.json().id).toBe(two.json().id);
      expect((await detail(id)).assets).toHaveLength(1);
      expect(
        (await upload(Buffer.concat([file, Buffer.from("different")]))).json()
          .error.code,
      ).toBe("IDEMPOTENCY_CONFLICT");
    });
    it("initializes an additional variant once and permits a normal receipt", async () => {
      const id = await create(),
        body = {
          operationKey: randomUUID(),
          sku: "OWNER-BLUE",
          inventoryExternalKey: "OWNER-BLUE",
          attributes: { Цвет: "Синий" },
          priceMinor: 20000,
          partnerCommissionUnitMinor: 0,
        };
      const url = `/api/v1/admin/products/${id}/variants`,
        one = await call("POST", url, body),
        two = await call("POST", url, body);
      expect(one.statusCode, one.body).toBe(200);
      expect(one.json().id).toBe(two.json().id);
      expect(
        (
          await call(
            "GET",
            `/api/v1/admin/shop/variants/${one.json().id}/stock`,
          )
        ).json(),
      ).toMatchObject({ initialized: true, onHand: 0 });
    });
    it("refuses a physical count below reserved units without changing the ledger", async () => {
      await f.service.checkout(
        f.owners[0]!.user,
        randomUUID(),
        f.request(14500, 2),
      );
      const url = `/api/v1/admin/shop/variants/${f.variant}/stock`,
        before = (await call("GET", url)).json();
      expect(before.reserved).toBe(2);
      const result = await call("POST", url, {
        operationKey: randomUUID(),
        kind: "COUNT",
        quantity: 0,
        expectedOnHand: 3,
        reason: "Проверка резерва",
        occurredAt: new Date().toISOString(),
      });
      expect(result.json().error.code).toBe("INSUFFICIENT_STOCK");
      expect((await call("GET", url)).json()).toEqual(before);
    });
    it("accepts exact decimal rubles and rejects precision loss", () => {
      expect(rublesToMinor("199,90")).toBe(19990);
      expect(rublesToMinor("0.29")).toBe(29);
      expect(() => rublesToMinor("1.005")).toThrow();
    });
  },
);
