"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { rublesToMinor, minorToRubles } from "@watch/contracts";
import {
  AdminCatalogLayout,
  Field,
  productStatusLabels,
  buttonClass,
  inputClass,
  readCategories,
  useAdminCatalogApi,
  type Category,
  type Product,
} from "./admin-catalog-common";
import { StockControls } from "./admin-stock-controls";
import { ProductPhotos } from "./admin-product-photos";
import {
  VariantForm,
  AssetCreateForm,
  AssetForm,
} from "./admin-product-advanced";
type Draft = {
  title: string;
  brand: string;
  description: string;
  categoryIds: string[];
  variants: {
    id: string;
    price: string;
    seller: string;
    commission: string;
    settlement: string;
  }[];
};
const draftFrom = (p: Product): Draft => ({
  title: p.title,
  brand: p.brand ?? "",
  description: p.description,
  categoryIds: p.categories.map((c) => c.id),
  variants: p.variants.map((v) => ({
    id: v.id,
    price: minorToRubles(v.priceMinor),
    seller:
      v.dropshipPriceMinor == null ? "" : minorToRubles(v.dropshipPriceMinor),
    commission: minorToRubles(v.partnerCommissionUnitMinor),
    settlement:
      v.supplierSettlementUnitMinor == null
        ? ""
        : minorToRubles(v.supplierSettlementUnitMinor),
  })),
});
export function AdminProductScreen({
  csrfToken,
  productId,
}: {
  csrfToken: string;
  productId: string;
}) {
  const api = useAdminCatalogApi(csrfToken),
    [product, setProduct] = useState<Product>(),
    [categories, setCategories] = useState<Category[]>([]);
  const [draft, setDraft] = useState<Draft>(),
    [recovery, setRecovery] = useState<Draft>(),
    [saveState, setSaveState] = useState("Сохранено"),
    [preview, setPreview] = useState(false),
    [retry, setRetry] = useState(0);
  const pendingSave = useRef<{ signature: string; key: string } | null>(null);
  const photoPending = useRef(false);
  const onPhotoPending = useCallback((value: boolean) => {
    photoPending.current = value;
  }, []);
  const previewDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (preview) previewDialog.current?.showModal();
  }, [preview]);
  const base = useRef<Product | undefined>(undefined),
    current = useRef<Draft | undefined>(undefined),
    saved = useRef(""),
    saving = useRef<Promise<Product | undefined> | null>(null);
  current.current = draft;
  const storageKey = `watch-product-draft:${productId}`;
  const dirty = () =>
    !!current.current && JSON.stringify(current.current) !== saved.current;
  const navigate = useCallback(() => {
    if (photoPending.current)
      return window.confirm(
        "Есть незагруженные фотографии. При выходе их придётся выбрать заново. Выйти?",
      );
    return (
      !dirty() ||
      window.confirm(
        "Есть несохранённые изменения. Они останутся на этом устройстве. Выйти?",
      )
    );
  }, []);
  const load = async () => {
    const p = await api.request<Product>(`/api/v1/admin/products/${productId}`);
    base.current = p;
    setProduct(p);
    return p;
  };
  const refresh = async () => {
    await load();
  };
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      api.request<Product>(
        `/api/v1/admin/products/${productId}`,
        "GET",
        undefined,
        abort.signal,
      ),
      readCategories(api.request, abort.signal),
    ])
      .then(([p, c]) => {
        if (abort.signal.aborted) return;
        base.current = p;
        saved.current = JSON.stringify(draftFrom(p));
        setProduct(p);
        setSaveState("Сохранено");
        setDraft(draftFrom(p));
        setCategories(c);
        try {
          const local = localStorage.getItem(storageKey);
          if (local && local !== saved.current) setRecovery(JSON.parse(local));
        } catch {
          /* Device storage can be unavailable. */
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) api.setError(e.message);
      });
    return () => abort.abort();
  }, [productId, retry, api.request, storageKey]);
  const save = useCallback(
    async function saveLatest(): Promise<Product | undefined> {
      if (saving.current) {
        await saving.current;
        if (dirty()) return saveLatest();
        return base.current;
      }
      if (!base.current || !current.current || !dirty()) return base.current;
      const snapshot = current.current,
        signature = JSON.stringify(snapshot),
        p = base.current;
      if (!pendingSave.current || pendingSave.current.signature !== signature)
        pendingSave.current = { signature, key: crypto.randomUUID() };
      const operationKey = pendingSave.current.key;
      setSaveState("Сохраняем");
      api.setError("");
      const task = (async () => {
        try {
          const updated = await api.request<Product>(
            `/api/v1/admin/shop/products/${productId}`,
            "PATCH",
            {
              operationKey,
              title: snapshot.title,
              brand: snapshot.brand,
              description: snapshot.description,
              categoryIds: snapshot.categoryIds,
              expectedUpdatedAt: p.updatedAt,
              variants: snapshot.variants.map((v) => ({
                id: v.id,
                expectedUpdatedAt: p.variants.find((x) => x.id === v.id)!
                  .updatedAt,
                priceMinor: rublesToMinor(v.price),
                dropshipPriceMinor:
                  v.seller === "" ? null : rublesToMinor(v.seller),
                partnerCommissionUnitMinor: rublesToMinor(v.commission),
                supplierSettlementUnitMinor:
                  v.settlement === "" ? null : rublesToMinor(v.settlement),
              })),
            },
          );
          base.current = updated;
          setProduct(updated);
          saved.current = signature;
          pendingSave.current = null;
          setSaveState(
            JSON.stringify(current.current) === signature
              ? "Сохранено"
              : "Есть изменения",
          );
          if (JSON.stringify(current.current) === signature)
            try {
              localStorage.removeItem(storageKey);
            } catch {
              /* Retain in memory. */
            }
          return updated;
        } catch (error) {
          setSaveState("Не удалось сохранить");
          api.setError(
            error instanceof Error
              ? error.message
              : "Не удалось сохранить. Введённые данные остались в форме.",
          );
          return undefined;
        }
      })();
      saving.current = task;
      try {
        return await task;
      } finally {
        saving.current = null;
      }
    },
    [api.request, productId, storageKey],
  );
  useEffect(() => {
    if (!draft || !dirty()) return;
    setSaveState("Есть изменения");
    try {
      localStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {
      /* Leave form intact. */
    }
    const timer = setTimeout(() => void save(), 900);
    return () => clearTimeout(timer);
  }, [draft, save, storageKey]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty() || photoPending.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
  const status = (value: string) =>
    void api.mutate(
      async () => {
        if (!(await save()) || dirty()) return;
        const p = await api.request<Product>(
          `/api/v1/admin/shop/products/${productId}/status`,
          "POST",
          { status: value },
        );
        base.current = p;
        setProduct(p);
        api.setNotice(
          value === "ACTIVE"
            ? "Товар опубликован."
            : value === "DRAFT"
              ? "Товар скрыт от покупателей."
              : "Товар перенесён в архив.",
        );
      },
      value === "ARCHIVED"
        ? "Перенести товар в архив? История заказов и склада сохранится."
        : undefined,
    );
  const setVariant = (id: string, field: string, value: string) =>
    setDraft(
      (d) =>
        d && {
          ...d,
          variants: d.variants.map((v) =>
            v.id === id ? { ...v, [field]: value } : v,
          ),
        },
    );
  return (
    <AdminCatalogLayout
      title={product?.title || "Товар"}
      back="/admin/catalog"
      beforeNavigate={navigate}
    >
      {api.error && (
        <p role="alert" className="rounded-lg bg-danger-soft p-4 text-danger">
          {api.error}
          <button
            type="button"
            className={`${buttonClass} mt-3`}
            onClick={() => {
              if (navigate()) {
                api.setError("");
                setRetry((n) => n + 1);
              }
            }}
          >
            Обновить сохранённые данные
          </button>
        </p>
      )}
      {api.notice && (
        <p role="status" className="text-success">
          {api.notice}
        </p>
      )}
      {!product || !draft ? (
        <>
          <p role="status">Загружаем карточку…</p>
          {api.error && (
            <button
              className={buttonClass}
              onClick={() => setRetry((n) => n + 1)}
            >
              Повторить загрузку
            </button>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="rounded-full bg-surface-muted px-3 py-1 text-sm">
              {productStatusLabels[product.status]}
            </p>
            <p role="status" aria-live="polite" className="text-sm text-muted">
              {saveState}
            </p>
          </div>
          {recovery && (
            <section className="app-panel space-y-3">
              <p>На этом устройстве есть несохранённые изменения.</p>
              <div className="flex flex-wrap gap-2">
                <button
                  className={buttonClass}
                  onClick={() => {
                    setDraft(recovery);
                    setRecovery(undefined);
                  }}
                >
                  Восстановить введённое
                </button>
                <button
                  className={buttonClass}
                  onClick={() => {
                    setRecovery(undefined);
                    try {
                      localStorage.removeItem(storageKey);
                    } catch {}
                  }}
                >
                  Оставить сохранённую версию
                </button>
              </div>
            </section>
          )}
          <form
            aria-label="Редактирование товара"
            className="app-panel space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <h2 className="text-xl">О товаре</h2>
            <Field label="Название">
              <input
                className={inputClass}
                maxLength={200}
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </Field>
            <Field label="Бренд">
              <input
                className={inputClass}
                maxLength={120}
                value={draft.brand}
                placeholder="Например, Casio"
                onChange={(e) => setDraft({ ...draft, brand: e.target.value })}
              />
            </Field>
            <Field label="Описание">
              <textarea
                className={`${inputClass} min-h-32`}
                maxLength={20000}
                value={draft.description}
                placeholder="Модель, механизм, размер, особенности и комплектация"
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
              />
            </Field>
            <fieldset className="space-y-2">
              <legend className="mb-2">Категория</legend>
              {categories.map((c) => (
                <label key={c.id} className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    disabled={
                      c.status !== "ACTIVE" && !draft.categoryIds.includes(c.id)
                    }
                    checked={draft.categoryIds.includes(c.id)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        categoryIds: e.target.checked
                          ? [...draft.categoryIds, c.id]
                          : draft.categoryIds.filter((id) => id !== c.id),
                      })
                    }
                  />
                  {c.name}
                  {c.status !== "ACTIVE" ? " · В архиве" : ""}
                </label>
              ))}
              {!categories.length && (
                <p>Добавьте категорию в каталоге перед публикацией.</p>
              )}
            </fieldset>
            {draft.variants.map((v) => {
              const variant = product.variants.find((x) => x.id === v.id)!;
              return (
                <div
                  key={v.id}
                  className="space-y-3 border-t border-hairline pt-4"
                >
                  <p className="text-sm text-muted">
                    {draft.variants.length > 1
                      ? `Вариант: ${Object.values(variant.attributes).join(" · ") || variant.sku}`
                      : `Артикул: ${variant.sku}`}
                  </p>
                  <Field
                    label={`Цена, ${variant.currency}${draft.variants.length > 1 ? ` · ${variant.sku}` : ""}`}
                  >
                    <input
                      className={inputClass}
                      inputMode="decimal"
                      value={v.price}
                      onChange={(e) =>
                        setVariant(v.id, "price", e.target.value)
                      }
                    />
                  </Field>
                  <details>
                    <summary>Цена для продавца и комиссии</summary>
                    <div className="space-y-3 pt-2">
                      <Field label="Цена для продавца, руб.">
                        <input
                          className={inputClass}
                          inputMode="decimal"
                          value={v.seller}
                          onChange={(e) =>
                            setVariant(v.id, "seller", e.target.value)
                          }
                        />
                      </Field>
                      <p className="text-sm text-muted">
                        Согласованная цена для заказа продавцом. Нужна для
                        публикации. Розничную цену система сюда не подставляет.
                      </p>
                      <Field label="Реферальная комиссия, руб.">
                        <input
                          className={inputClass}
                          inputMode="decimal"
                          value={v.commission}
                          onChange={(e) =>
                            setVariant(v.id, "commission", e.target.value)
                          }
                        />
                      </Field>
                      <Field label="Расчёт с поставщиком, руб. (необязательно)">
                        <input
                          className={inputClass}
                          inputMode="decimal"
                          value={v.settlement}
                          onChange={(e) =>
                            setVariant(v.id, "settlement", e.target.value)
                          }
                        />
                      </Field>
                    </div>
                  </details>
                </div>
              );
            })}
            <button className={buttonClass} type="submit">
              Сохранить сейчас
            </button>
          </form>
          <ProductPhotos
            product={product}
            csrfToken={csrfToken}
            refresh={refresh}
            onPendingChange={onPhotoPending}
          />
          <section className="app-panel space-y-3">
            <h2 className="text-xl">Публикация</h2>
            <p className="text-muted">
              Черновик виден только вам. Опубликованный товар с нулевым остатком
              останется в магазине с отметкой «Нет в наличии».
            </p>
            <div className="flex flex-wrap gap-2">
              <button className={buttonClass} onClick={() => setPreview(true)}>
                Предпросмотр
              </button>
              <button
                className={`${buttonClass} app-button-primary`}
                disabled={api.busy}
                onClick={() =>
                  status(product.status === "ACTIVE" ? "DRAFT" : "ACTIVE")
                }
              >
                {product.status === "ACTIVE" ? "Скрыть" : "Опубликовать"}
              </button>
              {product.status !== "ARCHIVED" && (
                <button
                  className={buttonClass}
                  disabled={api.busy}
                  onClick={() => status("ARCHIVED")}
                >
                  В архив
                </button>
              )}
            </div>
          </section>
          {product.variants.map((v) => (
            <StockControls
              key={v.id}
              variantId={v.id}
              csrfToken={csrfToken}
              title={product.variants.length > 1 ? v.sku : undefined}
            />
          ))}
          <details className="app-panel">
            <summary>Дополнительные варианты и материалы</summary>
            <p className="my-3 text-muted">
              Сначала сохраните основные поля. Эти настройки нужны для
              нескольких вариантов и материалов партнёрам.
            </p>
            <fieldset disabled={dirty() || api.busy} className="space-y-4">
              {product.variants.map((v) => (
                <form
                  key={`${v.id}:${v.updatedAt}`}
                  className="app-panel space-y-3"
                  aria-label={`Настройки ${v.sku}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void api.mutate(async () => {
                      await api.request(
                        `/api/v1/admin/variants/${v.id}`,
                        "PATCH",
                        {
                          status: String(form.get("status")),
                          safetyBuffer: Number(form.get("buffer")),
                        },
                      );
                      const p = await load(),
                        d = draftFrom(p);
                      saved.current = JSON.stringify(d);
                      setDraft(d);
                    }, "Изменить статус или дополнительный резерв варианта?");
                  }}
                >
                  <h3>{Object.values(v.attributes).join(" · ") || v.sku}</h3>
                  <p className="text-sm text-muted">Артикул: {v.sku}</p>
                  <Field label="Дополнительно отложить, шт.">
                    <input
                      className={inputClass}
                      type="number"
                      min={0}
                      step={1}
                      name="buffer"
                      defaultValue={v.inventory?.safetyBuffer ?? 0}
                    />
                  </Field>
                  <Field label="Статус варианта">
                    <select
                      className={inputClass}
                      name="status"
                      defaultValue={v.status}
                    >
                      {v.status === "DRAFT" && (
                        <option value="DRAFT">Черновик</option>
                      )}
                      <option value="ACTIVE">Активен</option>
                      <option value="ARCHIVED">В архиве</option>
                    </select>
                  </Field>
                  <button className={buttonClass}>
                    Сохранить настройки варианта
                  </button>
                </form>
              ))}
              <VariantForm
                mutate={api.mutate}
                save={async (payload) => {
                  await api.request(
                    `/api/v1/admin/products/${product.id}/variants`,
                    "POST",
                    payload,
                  );
                  const p = await load();
                  const d = draftFrom(p);
                  saved.current = JSON.stringify(d);
                  setDraft(d);
                }}
              />
              <AssetCreateForm
                variants={product.variants}
                mutate={api.mutate}
                save={async (type, form) => {
                  if (type === "TEXT")
                    await api.request(
                      `/api/v1/admin/products/${product.id}/assets/text`,
                      "POST",
                      {
                        text: String(form.get("text")),
                        purpose: String(form.get("purpose")),
                        variantId: String(form.get("variantId")) || null,
                      },
                    );
                  else {
                    const file = form.get("file");
                    if (!(file instanceof File))
                      throw new Error("Выберите файл");
                    const data = new FormData();
                    data.set("purpose", String(form.get("purpose")));
                    if (form.get("variantId"))
                      data.set("variantId", String(form.get("variantId")));
                    data.set("file", file);
                    await api.request(
                      `/api/v1/admin/products/${product.id}/assets/media`,
                      "POST",
                      data,
                    );
                  }
                  await refresh();
                }}
              />
              {product.assets
                .filter(
                  (a) =>
                    a.type !== "IMAGE" ||
                    a.purpose !== "STOREFRONT" ||
                    a.status !== "ACTIVE",
                )
                .map((a) => (
                  <AssetForm
                    key={`${a.id}:${a.sortOrder}:${a.status}`}
                    asset={a}
                    mutate={api.mutate}
                    save={async (payload) => {
                      await api.request(
                        `/api/v1/admin/assets/${a.id}`,
                        "PATCH",
                        payload,
                      );
                      await refresh();
                    }}
                  />
                ))}
            </fieldset>
          </details>
          {preview && (
            <dialog
              ref={previewDialog}
              onCancel={() => setPreview(false)}
              aria-label="Предпросмотр товара"
              className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto border-0 bg-canvas p-4 text-ink"
            >
              <div className="mx-auto max-w-lg space-y-4">
                <button
                  autoFocus
                  className={buttonClass}
                  onClick={() => setPreview(false)}
                >
                  Закрыть предпросмотр
                </button>
                <p className="text-muted">
                  Предпросмотр · товар не публикуется
                </p>
                <article className="shop-product overflow-hidden">
                  {product.assets.find(
                    (a) =>
                      a.type === "IMAGE" &&
                      a.purpose === "STOREFRONT" &&
                      a.status === "ACTIVE",
                  )?.mediaUrl && (
                    <img
                      className="aspect-square w-full object-cover"
                      alt={draft.title}
                      src={
                        product.assets.find(
                          (a) =>
                            a.type === "IMAGE" &&
                            a.purpose === "STOREFRONT" &&
                            a.status === "ACTIVE",
                        )!.mediaUrl!
                      }
                    />
                  )}
                  <div className="space-y-3 p-5">
                    <p className="text-muted">{draft.brand}</p>
                    <h2 className="text-2xl">
                      {draft.title || "Без названия"}
                    </h2>
                    <p className="shop-product-price">
                      {draft.variants[0]?.price} {product.variants[0]?.currency}
                    </p>
                    <p className="whitespace-pre-wrap">{draft.description}</p>
                  </div>
                </article>
              </div>
            </dialog>
          )}
        </>
      )}
    </AdminCatalogLayout>
  );
}
