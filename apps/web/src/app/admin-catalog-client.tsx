"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { rublesToMinor } from "@watch/contracts";
import {
  AdminCatalogLayout,
  Field,
  Pagination,
  StatusOptions,
  productStatusLabels,
  categoryStatusLabels,
  availabilityLabels,
  buttonClass,
  inputClass,
  useAdminCatalogApi,
  type Category,
  type PageData,
  type ProductCard,
} from "./admin-catalog-common";
export function AdminCatalogScreen({ csrfToken }: { csrfToken: string }) {
  const router = useRouter(),
    api = useAdminCatalogApi(csrfToken);
  const [query, setQuery] = useState("page=1&limit=20"),
    [categoryPage, setCategoryPage] = useState(1),
    [retry, setRetry] = useState(0),
    [adding, setAdding] = useState(false);
  const [products, setProducts] = useState<PageData<ProductCard>>(),
    [categories, setCategories] = useState<PageData<Category>>();
  const pending = useRef<{ signature: string; payload: object } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.setError("");
    void Promise.all([
      api.request<PageData<ProductCard>>(
        `/api/v1/admin/products?${query}`,
        "GET",
        undefined,
        controller.signal,
      ),
      api.request<PageData<Category>>(
        `/api/v1/admin/categories?page=${categoryPage}&limit=100`,
        "GET",
        undefined,
        controller.signal,
      ),
    ])
      .then(([p, c]) => {
        if (!controller.signal.aborted) {
          setProducts(p);
          setCategories(c);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) api.setError(e.message);
      });
    return () => controller.abort();
  }, [query, categoryPage, retry, api.request]);
  const refresh = () => setRetry((n) => n + 1);
  return (
    <AdminCatalogLayout title="Каталог товаров">
      <p className="text-muted">
        Товары, фотографии и остатки — в одном месте.
      </p>
      {api.error && (
        <p role="alert" className="rounded-lg bg-danger-soft p-3 text-danger">
          {api.error}
        </p>
      )}
      {api.notice && (
        <p role="status" className="text-success">
          {api.notice}
        </p>
      )}
      {api.denied ? (
        <p>У вас нет доступа к каталогу.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <button
              className={`${buttonClass} app-button-primary`}
              disabled={api.busy || pending.current !== null}
              onClick={() => setAdding((v) => !v)}
            >
              {adding ? "Закрыть добавление" : "Добавить товар"}
            </button>
            <button className={buttonClass} onClick={refresh}>
              Обновить
            </button>
          </div>
          {adding && (
            <form
              aria-label="Создать товар"
              className="app-panel space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                void api.mutate(async () => {
                  if (pending.current) {
                    const p = await api.request<{ id: string }>(
                      "/api/v1/admin/shop/products",
                      "POST",
                      pending.current.payload,
                    );
                    pending.current = null;
                    router.push(`/admin/products/${p.id}`);
                    return;
                  }
                  const fields = {
                    title: String(form.get("title")),
                    brand: String(form.get("brand")),
                    description: String(form.get("description")),
                    priceMinor: rublesToMinor(String(form.get("price"))),
                    initialQuantity: Number(form.get("quantity")),
                    categoryIds: form
                      .getAll("categoryIds")
                      .map(String)
                      .filter(Boolean),
                    ...(form.get("sku")
                      ? { sku: String(form.get("sku")) }
                      : {}),
                  };
                  const signature = JSON.stringify(fields);
                  pending.current = {
                    signature,
                    payload: { ...fields, operationKey: crypto.randomUUID() },
                  };
                  const p = await api.request<{ id: string }>(
                    "/api/v1/admin/shop/products",
                    "POST",
                    pending.current.payload,
                  );
                  pending.current = null;
                  router.push(`/admin/products/${p.id}`);
                });
              }}
            >
              <h2 className="text-xl">Новые часы</h2>
              <p className="text-muted">
                Сохраним черновик. Фотографии можно добавить на следующем шаге.
              </p>
              <fieldset
                disabled={api.busy || pending.current !== null}
                className="space-y-4"
              >
                <Field label="Название">
                  <input
                    className={inputClass}
                    name="title"
                    required
                    maxLength={200}
                    placeholder="Например, Casio Vintage A168"
                  />
                </Field>
                <Field label="Бренд">
                  <input
                    className={inputClass}
                    name="brand"
                    maxLength={120}
                    placeholder="Casio"
                  />
                </Field>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Цена, руб.">
                    <input
                      className={inputClass}
                      inputMode="decimal"
                      name="price"
                      required
                      defaultValue="0,00"
                    />
                  </Field>
                  <Field label="Начальное количество, шт.">
                    <input
                      className={inputClass}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={1000000}
                      step={1}
                      name="quantity"
                      required
                      defaultValue="0"
                    />
                  </Field>
                </div>
                <Field label="Описание">
                  <textarea
                    className={inputClass}
                    name="description"
                    maxLength={20000}
                  />
                </Field>
                <Field label="Категория">
                  <select className={inputClass} name="categoryIds">
                    <option value="">Выбрать позже</option>
                    {categories?.items
                      .filter((c) => c.status === "ACTIVE")
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <details>
                  <summary>Свой артикул</summary>
                  <Field label="Артикул (необязательно)">
                    <input
                      className={inputClass}
                      name="sku"
                      maxLength={80}
                      pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                      placeholder="Иначе создадим автоматически"
                    />
                  </Field>
                </details>
              </fieldset>
              {pending.current && api.error && (
                <p>
                  Повторите сохранение, чтобы получить уже созданную карточку.
                  Дубликат не появится.
                </p>
              )}
              <button
                className={`${buttonClass} app-button-primary`}
                disabled={api.busy}
              >
                {api.busy ? "Создаём…" : "Сохранить черновик и добавить фото"}
              </button>
            </form>
          )}
          <form
            className="app-panel space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget),
                next = new URLSearchParams({ page: "1", limit: "20" });
              for (const k of ["q", "status", "availability"])
                if (form.get(k)) next.set(k, String(form.get(k)));
              setQuery(next.toString());
            }}
          >
            <Field label="Поиск товаров">
              <input
                className={inputClass}
                name="q"
                maxLength={100}
                placeholder="Название, бренд или артикул"
              />
            </Field>
            <details>
              <summary>Фильтры по публикации и наличию</summary>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Публикация">
                  <select className={inputClass} name="status">
                    <option value="">Все товары</option>
                    {Object.entries(productStatusLabels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Наличие">
                  <select className={inputClass} name="availability">
                    <option value="">Любой остаток</option>
                    <option value="IN_STOCK">В наличии</option>
                    <option value="OUT_OF_STOCK">Нет в наличии</option>
                  </select>
                </Field>
              </div>
            </details>
            <button className={buttonClass}>Найти</button>
          </form>
          {!products && !api.error && <p role="status">Загружаем каталог…</p>}
          {products && (
            <section aria-label="Товары" className="space-y-4">
              <p className="text-sm text-muted">Товаров: {products.total}</p>
              {!products.items.length && (
                <div className="app-panel space-y-2">
                  <h2 className="text-lg">
                    {new URLSearchParams(query).has("q") ||
                    new URLSearchParams(query).has("status") ||
                    new URLSearchParams(query).has("availability")
                      ? "Ничего не найдено"
                      : "Здесь появятся ваши часы"}
                  </h2>
                  <p className="text-muted">
                    {query !== "page=1&limit=20"
                      ? "Попробуйте другой поиск или сбросьте фильтры."
                      : "Нажмите «Добавить товар», чтобы создать первую карточку."}
                  </p>
                  <button
                    className={buttonClass}
                    onClick={() => setQuery("page=1&limit=20")}
                  >
                    Сбросить фильтры
                  </button>
                </div>
              )}
              <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {products.items.map((p) => (
                  <li key={p.id} className="app-panel space-y-4">
                    <div className="flex gap-4">
                      {p.coverUrl ? (
                        <img
                          className="h-24 w-24 shrink-0 rounded-lg bg-surface-muted object-cover"
                          alt={p.title}
                          src={p.coverUrl}
                        />
                      ) : (
                        <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-sm text-muted">
                          Нет фото
                        </div>
                      )}
                      <div className="min-w-0 space-y-1">
                        <p className="text-xs text-muted">
                          {p.brand || "Бренд не указан"} ·{" "}
                          {productStatusLabels[p.status]}
                        </p>
                        <Link
                          className="break-words text-lg font-semibold"
                          href={`/admin/products/${p.id}`}
                        >
                          {p.title}
                        </Link>
                        <p className="font-semibold">
                          {p.variants.length
                            ? `${(p.variants[0]!.priceMinor / 100).toLocaleString("ru-BY", { minimumFractionDigits: 2 })} ${p.variants[0]!.currency}`
                            : "Цена не указана"}
                        </p>
                        <p className="text-sm text-muted">
                          {availabilityLabels[p.availability]} · Доступно{" "}
                          {p.sellable ?? 0} шт.
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Link
                        className={buttonClass}
                        href={`/admin/products/${p.id}`}
                      >
                        Редактировать
                      </Link>
                      <button
                        className={buttonClass}
                        disabled={api.busy}
                        onClick={() =>
                          void api.mutate(async () => {
                            await api.request(
                              `/api/v1/admin/shop/products/${p.id}/status`,
                              "POST",
                              {
                                status:
                                  p.status === "ACTIVE" ? "DRAFT" : "ACTIVE",
                              },
                            );
                            refresh();
                          })
                        }
                      >
                        {p.status === "ACTIVE" ? "Скрыть" : "Опубликовать"}
                      </button>
                      {p.status !== "ARCHIVED" && (
                        <button
                          className={buttonClass}
                          disabled={api.busy}
                          onClick={() =>
                            void api.mutate(async () => {
                              await api.request(
                                `/api/v1/admin/shop/products/${p.id}/status`,
                                "POST",
                                { status: "ARCHIVED" },
                              );
                              refresh();
                            }, "Перенести товар в архив? История сохранится.")
                          }
                        >
                          В архив
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <Pagination
                data={products}
                onPage={(page) => {
                  const next = new URLSearchParams(query);
                  next.set("page", String(page));
                  setQuery(next.toString());
                }}
              />
            </section>
          )}
          <details className="app-panel">
            <summary>Тестовый каталог</summary>
            <p className="my-3 text-muted">
              Добавит 8 опубликованных тестовых моделей. Все карточки отмечены
              «ТЕСТ», фотографии иллюстративные. Повтор не меняет остатки.
            </p>
            <button
              className={buttonClass}
              disabled={api.busy}
              onClick={() =>
                void api.mutate(async () => {
                  const result = await api.request<{ replayed: boolean }>(
                    "/api/v1/admin/shop/test-catalog",
                    "POST",
                    { confirmed: true },
                  );
                  api.setNotice(
                    result.replayed
                      ? "Тестовый каталог уже добавлен. Карточки и остатки сохранены."
                      : "Добавлено 8 тестовых товаров.",
                  );
                  refresh();
                }, "Добавить 8 тестовых товаров в этот магазин? Покупатели увидят опубликованные карточки с отметкой ТЕСТ.")
              }
            >
              Добавить тестовые часы
            </button>
          </details>
          <details className="app-panel">
            <summary>Категории товаров</summary>
            <div className="space-y-4 pt-4">
              <CategoryForm
                save={async (payload) => {
                  await api.request(
                    "/api/v1/admin/categories",
                    "POST",
                    payload,
                  );
                  refresh();
                }}
                mutate={api.mutate}
              />
              {categories?.items.map((c) => (
                <CategoryForm
                  key={`${c.id}:${c.updatedAt}`}
                  category={c}
                  save={async (payload) => {
                    await api.request(
                      `/api/v1/admin/categories/${c.id}`,
                      "PATCH",
                      payload,
                    );
                    refresh();
                  }}
                  mutate={api.mutate}
                />
              ))}
              {categories && (
                <Pagination data={categories} onPage={setCategoryPage} />
              )}
            </div>
          </details>
        </>
      )}
    </AdminCatalogLayout>
  );
}

function CategoryForm({
  category,
  save,
  mutate,
}: {
  category?: Category;
  save: (payload: object) => Promise<void>;
  mutate: (action: () => Promise<void>, confirmation?: string) => Promise<void>;
}) {
  return (
    <form
      aria-label={category ? `Категория ${category.name}` : "Новая категория"}
      className="space-y-3 app-panel"
      onSubmit={(event) => {
        event.preventDefault();
        const element = event.currentTarget;
        const form = new FormData(element);
        const payload = {
          name: String(form.get("name")),
          ...(form.get("slug") ? { slug: String(form.get("slug")) } : {}),
          sortOrder: Number(form.get("sortOrder")),
          ...(category ? { status: String(form.get("status")) } : {}),
        };
        void mutate(
          async () => {
            await save(payload);
            if (!category) element.reset();
          },
          payload.status && payload.status !== category?.status
            ? `Изменить статус категории на ${categoryStatusLabels[payload.status] ?? "Статус уточняется"}? Сервер проверит активные товары.`
            : undefined,
        );
      }}
    >
      <h3>
        {category
          ? `${category.name} · ${categoryStatusLabels[category.status] ?? "Статус уточняется"}`
          : "Новая категория"}
      </h3>
      <Field label="Название категории">
        <input
          className={inputClass}
          name="name"
          required
          maxLength={120}
          defaultValue={category?.name}
        />
      </Field>
      <Field label="Адрес категории (slug)">
        <input
          className={inputClass}
          name="slug"
          maxLength={140}
          defaultValue={category?.slug}
        />
      </Field>
      <Field label="Порядок в каталоге">
        <input
          className={inputClass}
          name="sortOrder"
          type="number"
          required
          min={0}
          step={1}
          defaultValue={category?.sortOrder ?? 0}
        />
      </Field>
      {category && (
        <Field label="Статус категории">
          <select
            className={inputClass}
            name="status"
            defaultValue={category.status}
          >
            <StatusOptions
              current={category.status}
              labels={categoryStatusLabels}
            />
          </select>
        </Field>
      )}
      <button className={buttonClass}>
        {category ? "Сохранить категорию" : "Создать категорию"}
      </button>
    </form>
  );
}
