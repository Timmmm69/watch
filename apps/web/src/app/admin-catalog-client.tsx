"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { AdminCatalogLayout, Field, Pagination, StatusOptions, availabilityLabels, buttonClass, inputClass,
  useAdminCatalogApi, type Category, type PageData, type ProductCard } from "./admin-catalog-common";

export function AdminCatalogScreen({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const api = useAdminCatalogApi(csrfToken);
  const [query, setQuery] = useState("page=1&limit=20");
  const [categoryPage, setCategoryPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [products, setProducts] = useState<PageData<ProductCard>>();
  const [categories, setCategories] = useState<PageData<Category>>();
  useEffect(() => {
    const controller = new AbortController(); setProducts(undefined); setCategories(undefined); api.setError("");
    void Promise.all([
      api.request<PageData<ProductCard>>(`/api/v1/admin/products?${query}`, "GET", undefined, controller.signal),
      api.request<PageData<Category>>(`/api/v1/admin/categories?page=${categoryPage}&limit=20`, "GET", undefined, controller.signal)
    ]).then(([p, c]) => { if (!controller.signal.aborted) { setProducts(p); setCategories(c); } })
      .catch(cause => { if (!controller.signal.aborted) api.setError(cause.message); });
    return () => controller.abort();
  }, [query, categoryPage, retry, api.request]);
  const refresh = () => setRetry(n => n + 1);
  const createProduct = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void api.mutate(async () => {
      const product = await api.request<{ id: string }>("/api/v1/admin/products", "POST", { title: String(form.get("title")) });
      router.push(`/admin/products/${product.id}`);
    });
  };
  return <AdminCatalogLayout title="Управление каталогом">
    {api.error && <p role="alert" className="text-amber-300">{api.error}</p>}
    {api.denied ? <p>Управление каталогом недоступно.</p> : <>
      <button className={buttonClass} disabled={api.busy} onClick={refresh}>Обновить</button>
      {(!products || !categories) && !api.error && <p role="status">Загрузка каталога…</p>}
      <fieldset disabled={api.busy} className="space-y-5">
        <form aria-label="Создать товар" className="space-y-3 rounded bg-slate-900 p-4" onSubmit={createProduct}>
          <h2 className="text-lg font-semibold">Новый товар</h2><Field label="Название нового товара"><input className={inputClass} name="title" required maxLength={200} /></Field>
          <button className={buttonClass}>Создать DRAFT</button>
        </form>
        <form className="flex flex-wrap items-end gap-3" onSubmit={event => {
          event.preventDefault(); const form = new FormData(event.currentTarget); const next = new URLSearchParams({ page: "1", limit: "20" });
          for (const key of ["q", "status"]) if (form.get(key)) next.set(key, String(form.get(key)));
          setQuery(next.toString());
        }}><Field label="Поиск товаров"><input name="q" maxLength={100} className={inputClass} /></Field>
          <Field label="Статус товаров"><select name="status" className={inputClass}><option value="">Все</option><option>DRAFT</option><option>ACTIVE</option><option>ARCHIVED</option></select></Field>
          <button className={buttonClass}>Применить</button></form>
        {products && <section aria-label="Товары">
          <h2 className="text-lg font-semibold">Товары</h2>{products.items.length === 0 && <p>Товаров нет</p>}
          <ul className="space-y-3">{products.items.map(product => <li key={product.id} className="rounded bg-slate-900 p-4">
            <Link className="underline" href={`/admin/products/${product.id}`}>{product.title}</Link>
            <p>{product.status} · {product.brand ?? "Без бренда"} · {availabilityLabels[product.availability] ?? product.availability}</p>
            <p>Категории: {product.categories.map(c => `${c.name} (${c.status})`).join(", ") || "не назначены"}</p>
            <p>Варианты: {product.variants.map(v => `${v.sku} (${v.status}) — ${v.priceMinor / 100} ${v.currency}`).join(", ") || "не созданы"}</p>
          </li>)}</ul><Pagination data={products} onPage={page => { const next = new URLSearchParams(query); next.set("page", String(page)); setQuery(next.toString()); }} />
        </section>}
        <section aria-label="Категории" className="space-y-4"><h2 className="text-lg font-semibold">Категории</h2>
          <CategoryForm save={async (payload) => { await api.request("/api/v1/admin/categories", "POST", payload); refresh(); }} mutate={api.mutate} />
          {categories?.items.length === 0 && <p>Категорий нет</p>}
          {categories?.items.map(category => <CategoryForm key={`${category.id}:${category.updatedAt}`} category={category}
            save={async payload => { await api.request(`/api/v1/admin/categories/${category.id}`, "PATCH", payload); refresh(); }} mutate={api.mutate} />)}
          {categories && <Pagination data={categories} onPage={setCategoryPage} />}
        </section>
      </fieldset>{api.busy && <p role="status">Сохранение…</p>}
    </>}
  </AdminCatalogLayout>;
}

function CategoryForm({ category, save, mutate }: { category?: Category; save: (payload: object) => Promise<void>; mutate: (action: () => Promise<void>, confirmation?: string) => Promise<void> }) {
  return <form aria-label={category ? `Категория ${category.name}` : "Новая категория"} className="space-y-3 rounded border border-slate-700 p-4" onSubmit={event => {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element);
    const payload = { name: String(form.get("name")), ...(form.get("slug") ? { slug: String(form.get("slug")) } : {}),
      sortOrder: Number(form.get("sortOrder")), ...(category ? { status: String(form.get("status")) } : {}) };
    void mutate(async () => { await save(payload); if (!category) element.reset(); }, payload.status && payload.status !== category?.status ? `Изменить статус категории на ${payload.status}? Сервер проверит активные товары.` : undefined);
  }}>
    <h3>{category ? `${category.name} · ${category.status}` : "Новая категория"}</h3>
    <Field label="Название категории"><input className={inputClass} name="name" required maxLength={120} defaultValue={category?.name} /></Field>
    <Field label="Slug категории"><input className={inputClass} name="slug" maxLength={140} defaultValue={category?.slug} /></Field>
    <Field label="Порядок категории"><input className={inputClass} name="sortOrder" type="number" required min={0} step={1} defaultValue={category?.sortOrder ?? 0} /></Field>
    {category && <Field label="Статус категории"><select className={inputClass} name="status" defaultValue={category.status}><StatusOptions current={category.status} /></select></Field>}
    <button className={buttonClass}>{category ? "Сохранить категорию" : "Создать категорию"}</button>
  </form>;
}
