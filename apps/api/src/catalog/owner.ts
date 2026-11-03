import { resolve } from "node:path";
import { addOwnerDemo } from "./owner-demo.js";
import type { ObjectStorage } from "./assets.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  ownerCreateSchema,
  ownerEditSchema,
  ownerStockSchema,
  type OwnerCreate,
  type OwnerEdit,
  type OwnerStock,
} from "@watch/contracts";
import {
  CatalogService,
  CatalogValidationError,
  type VariantCreateInput,
} from "./catalog.js";
import {
  inventoryTransaction,
  NativeInventoryService,
  NativeInventoryError,
} from "../inventory/native.js";
import { replayOperation, rememberOperation } from "./operations.js";

/** One transaction over the existing catalog and native ledger. No parallel stock field. */
export class OwnerCatalogService {
  constructor(
    private readonly pool: Pool,
    private readonly currency: string,
    private readonly storage?: ObjectStorage,
    private readonly fixtureDirectory = resolve(
      process.cwd(),
      "apps/api/fixtures/demo-catalog",
    ),
  ) {}
  async demo(actor: string) {
    if (!this.storage)
      throw new CatalogValidationError("Хранилище фотографий не подключено");
    return addOwnerDemo(
      this.pool,
      this.currency,
      this.storage,
      actor,
      this.fixtureDirectory,
    );
  }
  async create(actor: string, input: OwnerCreate) {
    return inventoryTransaction(this.pool, async (client) => {
      const replay = await replayOperation<{ id: string }>(
        client,
        input.operationKey,
        actor,
        "CREATE",
        input,
      );
      if (replay) return replay;
      const native = new NativeInventoryService(this.pool);
      const op = {
        actorUserId: actor,
        operationKey: input.operationKey,
        reason: "Начальное количество при добавлении товара",
        occurredAt: new Date(),
      };
      await native.selectAuthority(client, op);
      const catalog = new CatalogService(
        this.pool,
        this.currency,
        undefined,
        undefined,
        client,
        true,
      );
      const product = await catalog.createProduct(actor, {
        title: input.title,
        brand: input.brand || null,
        description: input.description,
        categoryIds: input.categoryIds,
      });
      const sku = input.sku || `W-${randomUUID().slice(0, 12).toUpperCase()}`;
      const variant = await catalog.createVariant(actor, product.id, {
        sku,
        inventoryExternalKey: sku,
        priceMinor: input.priceMinor,
        partnerCommissionUnitMinor: 0,
      });
      const initialization = randomUUID();
      await client.query(
        "INSERT INTO inventory_initializations(id,operation_key,source_reference,actor_user_id,reason,occurred_at) VALUES($1,$2,'admin-product',$3,$4,$5)",
        [initialization, input.operationKey, actor, op.reason, op.occurredAt],
      );
      await native.initialize(client, op, initialization, [
        {
          variantId: variant.id,
          quantity: input.initialQuantity,
          cost: input.initialQuantity === 0 ? 0 : null,
        },
      ]);
      const result = { id: product.id };
      await rememberOperation(
        client,
        input.operationKey,
        actor,
        "CREATE",
        input,
        result,
      );
      return result;
    });
  }
  async save(actor: string, id: string, input: OwnerEdit) {
    return inventoryTransaction(this.pool, async (client) => {
      const catalog = new CatalogService(
        this.pool,
        this.currency,
        undefined,
        undefined,
        client,
        true,
      );
      const replay = await replayOperation<{ id: string; updatedAt: string }>(
        client,
        input.operationKey,
        actor,
        "SAVE",
        { id, ...input },
      );
      if (replay) {
        const current = await catalog.getProduct(id);
        if (current.updatedAt.toISOString() !== replay.updatedAt)
          throw new CatalogValidationError(
            "После вашего сохранения карточка изменена в другом окне. Обновите данные и сверьте изменения.",
            {},
            "EDIT_CONFLICT",
          );
        return current;
      }
      // Follow catalog lock order: categories → product → variants → stock.
      const preliminary = await catalog.getProduct(id);
      await client.query(
        "SELECT id FROM categories WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [
          [
            ...new Set([
              ...input.categoryIds,
              ...preliminary.categories.map((c) => c.id),
            ]),
          ],
        ],
      );
      await client.query("SELECT id FROM products WHERE id=$1 FOR UPDATE", [
        id,
      ]);
      const product = await catalog.getProduct(id);
      if (
        product.updatedAt.toISOString() !== input.expectedUpdatedAt ||
        product.variants.some((v) => {
          const proposed = input.variants.find((p) => p.id === v.id);
          return (
            !proposed ||
            proposed.expectedUpdatedAt !== v.updatedAt.toISOString()
          );
        }) ||
        product.variants.length !== input.variants.length
      )
        throw new CatalogValidationError(
          "Карточка изменена в другом окне. Ваш текст сохранён на этом устройстве. Обновите данные и сверьте изменения.",
          {},
          "EDIT_CONFLICT",
        );
      await catalog.updateProduct(actor, id, {
        title: input.title,
        brand: input.brand || null,
        description: input.description,
        categoryIds: input.categoryIds,
      });
      for (const variant of input.variants)
        await catalog.updateVariant(actor, variant.id, {
          priceMinor: variant.priceMinor,
          partnerCommissionUnitMinor: variant.partnerCommissionUnitMinor,
          supplierSettlementUnitMinor: variant.supplierSettlementUnitMinor,
          ...(variant.dropshipPriceMinor === null
            ? {}
            : { dropshipPriceMinor: variant.dropshipPriceMinor }),
        });
      const result = await catalog.getProduct(id);
      await rememberOperation(
        client,
        input.operationKey,
        actor,
        "SAVE",
        { id, ...input },
        { id, updatedAt: result.updatedAt.toISOString() },
      );
      return result;
    });
  }
  async status(
    actor: string,
    id: string,
    status: "ACTIVE" | "DRAFT" | "ARCHIVED",
  ) {
    return inventoryTransaction(this.pool, async (client) => {
      const catalog = new CatalogService(
        this.pool,
        this.currency,
        undefined,
        undefined,
        client,
        true,
      );
      const initial = await catalog.getProduct(id);
      await client.query(
        "SELECT id FROM categories WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [initial.categories.map((c) => c.id)],
      );
      await client.query("SELECT id FROM products WHERE id=$1 FOR UPDATE", [
        id,
      ]);
      const p = await catalog.getProduct(id);
      if (status === "ACTIVE") {
        const issues = [];
        if (!p.title.trim()) issues.push("Укажите название");
        if (!p.description.trim()) issues.push("Добавьте описание");
        if (!p.categories.some((c) => c.status === "ACTIVE"))
          issues.push("Выберите активную категорию");
        if (
          !p.assets.some(
            (a) =>
              a.type === "IMAGE" &&
              a.purpose === "STOREFRONT" &&
              a.status === "ACTIVE" &&
              a.variantId === null,
          )
        )
          issues.push("Добавьте общее фото товара");
        const variants = p.variants.filter((v) => v.status !== "ARCHIVED");
        if (!variants.length) issues.push("Добавьте вариант товара");
        for (const v of variants) {
          if (v.priceMinor <= 0)
            issues.push(`Укажите розничную цену: ${v.sku}`);
          if (v.dropshipPriceMinor == null)
            issues.push(
              `Укажите цену для продавца в дополнительных настройках: ${v.sku}`,
            );
          const stock = await client.query(
            "SELECT native_initialization_id FROM inventory_items WHERE variant_id=$1",
            [v.id],
          );
          if (!stock.rows[0]?.native_initialization_id)
            issues.push(`Внесите начальный остаток: ${v.sku}`);
        }
        if (issues.length)
          throw new CatalogValidationError(issues.join(". "), { issues });
        for (const v of variants)
          if (v.status !== "ACTIVE")
            await catalog.updateVariant(actor, v.id, { status: "ACTIVE" });
      }
      await catalog.updateProduct(actor, id, { status });
      return catalog.getProduct(id);
    });
  }
  async addVariant(
    actor: string,
    productId: string,
    input: VariantCreateInput & { operationKey?: string | undefined },
  ) {
    return inventoryTransaction(this.pool, async (client) => {
      const key = input.operationKey ?? randomUUID();
      const replay = await replayOperation<{ id: string }>(
        client,
        key,
        actor,
        "VARIANT",
        { productId, ...input },
      );
      if (replay) return replay;
      const catalog = new CatalogService(
        this.pool,
        this.currency,
        undefined,
        undefined,
        client,
        true,
      );
      const variant = await catalog.createVariant(actor, productId, input),
        native = new NativeInventoryService(this.pool);
      const op = {
          actorUserId: actor,
          operationKey: key,
          reason: "Новый вариант: начальный остаток 0",
          occurredAt: new Date(),
        },
        initialization = randomUUID();
      await client.query(
        "INSERT INTO inventory_initializations(id,operation_key,source_reference,actor_user_id,reason,occurred_at) VALUES($1,$2,'admin-variant',$3,$4,$5)",
        [initialization, key, actor, op.reason, op.occurredAt],
      );
      await native.initialize(client, op, initialization, [
        { variantId: variant.id, quantity: 0, cost: 0 },
      ]);
      await rememberOperation(
        client,
        key,
        actor,
        "VARIANT",
        { productId, ...input },
        { id: variant.id },
      );
      return variant;
    });
  }
  async stock(actor: string, variantId: string, input: OwnerStock) {
    const quantity =
      input.kind === "COUNT"
        ? input.quantity - input.expectedOnHand
        : input.kind === "WRITE_OFF"
          ? -input.quantity
          : input.quantity;
    if (quantity === 0)
      throw new CatalogValidationError(
        "Количество не изменилось. Укажите ненулевое изменение.",
      );
    try {
      return await new NativeInventoryService(this.pool).change(
        {
          actorUserId: actor,
          operationKey: input.operationKey,
          reason: input.reason,
          occurredAt: new Date(input.occurredAt),
        },
        variantId,
        input.kind === "RECEIPT" ? "RECEIPT" : "CORRECTION",
        quantity,
        null,
        input.kind === "COUNT" ? input.expectedOnHand : undefined,
      );
    } catch (error) {
      if (error instanceof NativeInventoryError)
        throw new CatalogValidationError(
          error.message === "STOCK_CHANGED"
            ? "Остаток изменился после пересчёта. Обновите данные и проверьте количество."
            : error.message === "INSUFFICIENT_STOCK"
              ? "Нельзя списать товар, отложенный под заказы. Проверьте свободный остаток."
              : error.message === "NOT_INITIALIZED"
                ? "Этот вариант ещё не введён в склад. Выполните проверенный первоначальный перенос."
                : "Не удалось изменить остаток. Проверьте количество и повторите запрос.",
          {},
          error.message,
        );
      throw error;
    }
  }
  async stockDetail(variantId: string) {
    const state = (
      await this.pool.query(
        `SELECT native_on_hand AS "onHand", native_reserved_quantity AS reserved, safety_buffer AS buffer,
      GREATEST(0,native_on_hand-native_reserved_quantity-safety_buffer) AS available, native_initialization_id IS NOT NULL AS initialized FROM inventory_items WHERE variant_id=$1`,
        [variantId],
      )
    ).rows[0];
    if (!state) throw new CatalogValidationError("Вариант товара не найден");
    const history = await this.pool.query(
      `SELECT m.id,m.kind,m.quantity,m.on_hand_delta AS delta,m.on_hand_after AS "onHandAfter",m.reason,m.occurred_at AS "occurredAt",u.first_name AS actor
      FROM inventory_movements m JOIN users u ON u.id=m.actor_user_id WHERE m.variant_id=$1 ORDER BY m.sequence DESC LIMIT 100`,
      [variantId],
    );
    return { ...state, history: history.rows };
  }
}
