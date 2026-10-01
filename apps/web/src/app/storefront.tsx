"use client";

import { useEffect, useState, type FormEvent } from "react";
import { CartIndicator, ProductCartActions } from "./cart-client";
import { PartnerEarnings } from "./earnings-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { partnerReacceptUrl } from "./partner-client";

type Availability = "IN_STOCK" | "OUT_OF_STOCK" | "STALE" | "UNKNOWN";
type PartnerViewReason = "PARTNER_BLOCKED" | "TERMS_REACCEPT_REQUIRED" | null;
type Asset = { id: string; type: string; purpose?: string; mediaUrl: string | null; text: string | null };
type ProductCardPartnerView = { commissionFromMinor: number; commissionToMinor: number; referralEligible: boolean; readOnlyReason: PartnerViewReason };
type Product = { id: string; slug: string; title: string; description: string; brand: string | null;
  priceFromMinor: number | null; currency: string; availability: Availability;
  gallery: Asset[]; partnerView?: ProductCardPartnerView };
type VariantPartnerView = { id: string; commissionUnitMinor: number; referralEligible: boolean; readOnlyReason: PartnerViewReason };
type Detail = Product & { variants: { id: string; sku: string; priceMinor: number; availability: Availability }[];
  partnerView?: { referralEligible: boolean; readOnlyReason: PartnerViewReason; variants: VariantPartnerView[]; assets: Asset[] } };
type Category = { id: string; slug: string; name: string };
type Filters = { q: string; category: string; brand: string; minPrice: string; maxPrice: string; availability: string };
const empty: Filters = { q: "", category: "", brand: "", minPrice: "", maxPrice: "", availability: "" };
const labels: Record<Availability, string> = { IN_STOCK: "В наличии", OUT_OF_STOCK: "Нет в наличии",
  STALE: "Наличие уточняется", UNKNOWN: "Наличие уточняется" };
const reasonLabel = (reason: PartnerViewReason) => reason === "PARTNER_BLOCKED" ? "Партнёр заблокирован"
  : reason === "TERMS_REACCEPT_REQUIRED" ? "Требуется принять новые условия" : null;
const price = (minor: number | null, currency: string) => minor === null ? "Цена уточняется" :
  new Intl.NumberFormat("ru-BY", { style: "currency", currency }).format(minor / 100);

export function Storefront({ name, csrfToken, partner, partnerTermsReacceptRequired }: {
  name: string; csrfToken: string; partner: { id: string; status: "ACTIVE" | "BLOCKED" } | null;
  partnerTermsReacceptRequired: boolean;
}) {
  const router = useRouter();
  const [items, setItems] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<Filters>(empty);
  const [filters, setFilters] = useState<Filters>(empty);
  const [drawer, setDrawer] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [filterError, setFilterError] = useState("");
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState("");
  const [linkLoading, setLinkLoading] = useState(false);
  const limit = 20;

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/catalog/categories", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ items: Category[] }>; })
      .then((result) => setCategories(result.items)).catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (filters.q) params.set("q", filters.q);
    if (filters.category) params.set("category", filters.category);
    if (filters.brand) params.set("brand", filters.brand);
    if (filters.minPrice) params.set("minPriceMinor", String(Math.round(Number(filters.minPrice) * 100)));
    if (filters.maxPrice) params.set("maxPriceMinor", String(Math.round(Number(filters.maxPrice) * 100)));
    if (filters.availability) params.set("availability", filters.availability);
    setLoaded(false); setError(false);
    void fetch(`/api/v1/catalog/products?${params}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ items: Product[]; total: number }>; })
      .then((result) => { setItems(result.items); setTotal(result.total); setLoaded(true); })
      .catch(() => { if (!controller.signal.aborted) { setError(true); setLoaded(true); } });
    return () => controller.abort();
  }, [filters, page, retry]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (draft.minPrice && draft.maxPrice && Number(draft.minPrice) > Number(draft.maxPrice)) {
      setFilterError("Минимальная цена не может быть выше максимальной.");
      return;
    }
    setFilterError("");
    setFilters({ ...draft, q: draft.q.trim(), brand: draft.brand.trim() });
    setPage(1); setDrawer(false);
  };
  const reset = () => { setDraft(empty); setFilters(empty); setPage(1); setDrawer(false); setFilterError(""); };
  const open = async (slug: string) => {
    setError(false); setLink(""); setLinkError("");
    try {
      const response = await fetch(`/api/v1/catalog/products/${encodeURIComponent(slug)}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error();
      setDetail(await response.json() as Detail);
    } catch { setError(true); }
  };

  useEffect(() => {
    const slug = new URLSearchParams(window.location.search).get("product");
    if (slug) void open(slug);
  }, []);

  const copyReferral = async (productId: string | null) => {
    setLinkLoading(true); setLinkError(""); setLink("");
    try {
      const response = await fetch("/api/v1/partner/referral-links", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ productId })
      });
      const result = await response.json() as { url: string; error?: { code: string } };
      if (result.error?.code === "TERMS_REACCEPT_REQUIRED") { router.push(partnerReacceptUrl()); return; }
      if (!response.ok) throw new Error();
      setLink(result.url);
      await navigator.clipboard.writeText(result.url);
    } catch { setLinkError("Не удалось скопировать ссылку. Повторите попытку."); }
    finally { setLinkLoading(false); }
  };

  return <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100"><div className="mx-auto max-w-4xl">
    <header className="mb-8 flex items-center justify-between gap-3"><h1 className="text-2xl font-semibold">Watch</h1>
      <span className="text-sm text-slate-400">Здравствуйте, {name}</span></header>
    <nav className="mb-5 flex gap-4">
      <Link className="min-h-11 underline" href="/orders">Мои заказы</Link>
      {partner ? <Link className="min-h-11 underline" href="/partner">Партнёрский кабинет</Link>
        : <Link className="min-h-11 underline" href="/partner/onboarding">Стать партнёром</Link>}
      {partnerTermsReacceptRequired && <Link className="min-h-11 underline" href="/partner/onboarding">Принять новые условия</Link>}
    </nav>
    {!detail && <CartIndicator csrfToken={csrfToken} />}
    {partner && !detail && <PartnerEarnings compact blocked={partner.status === "BLOCKED"} />}
    {partner && !detail && <section className="mb-6 rounded-xl bg-slate-900 p-4" aria-label="Партнёрская ссылка">
      <h2 className="text-lg font-semibold">Ваша ссылка на магазин</h2>
      {partner.status === "ACTIVE" && !partnerTermsReacceptRequired
        ? <button type="button" disabled={linkLoading} className="mt-3 min-h-11 rounded-lg bg-blue-600 px-4 disabled:opacity-50"
            onClick={() => void copyReferral(null)}>Скопировать ссылку</button>
        : <p className="mt-2 text-amber-300">{partner.status === "BLOCKED" ? "Партнёр заблокирован" : "Требуется принять новые условия"}</p>}
      {link && <p className="mt-2 break-all text-sm text-emerald-300">Ссылка скопирована: {link}</p>}
      {linkError && <p role="alert" className="mt-2 text-rose-300">{linkError}</p>}
    </section>}
    {error && <div role="alert" className="mb-5 flex items-center gap-4 text-rose-300">Не удалось загрузить каталог.
      <button type="button" className="min-h-11 underline" onClick={() => { if (detail) void open(detail.slug); else setRetry((n) => n + 1); }}>Повторить</button></div>}
    {detail ? <section>
      <button type="button" className="mb-5 min-h-11 underline" onClick={() => {
        setDetail(null); setLink(""); setLinkError("");
        if (window.location.search) window.history.replaceState(null, "", "/shop");
      }}>← Все товары</button>
      <h2 className="mb-2 text-3xl font-semibold">{detail.title}</h2>
      {detail.brand && <p className="text-slate-300">{detail.brand}</p>}
      <p className="mb-5 text-slate-300">{detail.description}</p>
      <div className="grid gap-4 sm:grid-cols-2">{detail.gallery.map((asset) => asset.type === "IMAGE" && asset.mediaUrl
        ? <img key={asset.id} src={asset.mediaUrl} alt={detail.title} className="w-full rounded-xl bg-slate-900 object-contain" />
        : asset.type === "VIDEO" && asset.mediaUrl ? <video key={asset.id} src={asset.mediaUrl} controls className="w-full rounded-xl bg-slate-900" />
          : asset.text ? <p key={asset.id} className="rounded-xl bg-slate-900 p-4">{asset.text}</p> : null)}</div>
      {detail.partnerView && <div className="mt-6 rounded-xl bg-slate-900 p-4">
        <h3 className="mb-3 text-lg font-semibold">Партнёрская информация</h3>
        {detail.partnerView.referralEligible
          ? <button type="button" disabled={linkLoading} className="mb-3 min-h-11 rounded-lg bg-blue-600 px-4 disabled:opacity-50"
              onClick={() => void copyReferral(detail.id)}>Скопировать ссылку на товар</button>
          : <p className="mb-3 text-amber-300">{reasonLabel(detail.partnerView.readOnlyReason) ?? "Реферальная ссылка недоступна"}</p>}
        {link && <p className="mb-3 break-all text-sm text-emerald-300">Ссылка скопирована: {link}</p>}
        {linkError && <p role="alert" className="mb-3 text-rose-300">{linkError}</p>}
        <table className="w-full text-left text-sm"><thead><tr className="text-slate-400"><th className="pb-2">Артикул</th><th className="pb-2">Комиссия</th></tr></thead><tbody>
          {detail.partnerView.variants.map((variant) => <tr key={variant.id} className="border-t border-slate-700">
            <td className="py-2">{detail.variants.find((v) => v.id === variant.id)?.sku ?? variant.id}</td>
            <td className="py-2 text-emerald-300">{price(variant.commissionUnitMinor, detail.currency)}</td>
          </tr>)}
        </tbody></table>
        {detail.partnerView.assets.length > 0 && <div className="mt-4 grid gap-4 sm:grid-cols-2">{detail.partnerView.assets.map((asset) => asset.type === "IMAGE" && asset.mediaUrl
          ? <img key={asset.id} src={asset.mediaUrl} alt="Партнёрский материал" className="w-full rounded-xl bg-slate-950 object-contain" />
          : asset.type === "VIDEO" && asset.mediaUrl ? <video key={asset.id} src={asset.mediaUrl} controls className="w-full rounded-xl bg-slate-950" />
            : asset.text ? <p key={asset.id} className="rounded-xl bg-slate-950 p-4">{asset.text}</p> : null)}</div>}
      </div>}
      <p className="mt-6 text-lg font-medium">От {price(detail.priceFromMinor, detail.currency)}</p>
      <p className="mt-2">{labels[detail.availability]}</p>
      <ProductCartActions key={detail.id} variants={detail.variants} currency={detail.currency} csrfToken={csrfToken} />
    </section> : <>
      <form onSubmit={apply} className="mb-5 flex gap-2"><label className="sr-only" htmlFor="shop-search">Поиск товаров</label>
        <input id="shop-search" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          placeholder="Поиск товаров" maxLength={100} className="min-h-11 min-w-0 flex-1 rounded-lg bg-slate-800 px-3" />
        <button className="min-h-11 rounded-lg bg-blue-600 px-4">Найти</button>
        <button type="button" className="min-h-11 rounded-lg bg-slate-800 px-4" onClick={() => setDrawer(true)}>Фильтры</button></form>
      {categories.length > 0 && <nav aria-label="Категории" className="mb-5 flex gap-2 overflow-x-auto pb-2">
        {[{ id: "", slug: "", name: "Все" }, ...categories].map((category) => <button key={category.id} type="button"
          aria-pressed={filters.category === category.slug} className="min-h-11 shrink-0 rounded-full bg-slate-800 px-4 aria-pressed:bg-blue-600"
          onClick={() => { setFilters({ ...filters, category: category.slug }); setDraft({ ...draft, category: category.slug }); setPage(1); }}>{category.name}</button>)}
      </nav>}
      {drawer && <div className="fixed inset-0 z-10 flex items-end bg-black/70 sm:items-center sm:justify-center">
        <form onSubmit={apply} aria-label="Фильтры каталога" className="w-full max-w-lg rounded-t-2xl bg-slate-900 p-5 sm:rounded-2xl">
          <div className="mb-4 flex items-center justify-between"><h2 className="text-xl font-semibold">Фильтры</h2>
            <button type="button" className="min-h-11 px-3" onClick={() => setDrawer(false)}>Закрыть</button></div>
          <label className="mb-3 block">Бренд<input value={draft.brand} maxLength={120} onChange={(e) => setDraft({ ...draft, brand: e.target.value })}
            className="mt-1 min-h-11 w-full rounded-lg bg-slate-800 px-3" /></label>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <label>Цена от<input type="number" min="0" max="21474836.47" step="0.01" value={draft.minPrice} onChange={(e) => setDraft({ ...draft, minPrice: e.target.value })}
              className="mt-1 min-h-11 w-full rounded-lg bg-slate-800 px-3" /></label>
            <label>Цена до<input type="number" min="0" max="21474836.47" step="0.01" value={draft.maxPrice} onChange={(e) => setDraft({ ...draft, maxPrice: e.target.value })}
              className="mt-1 min-h-11 w-full rounded-lg bg-slate-800 px-3" /></label></div>
          {filterError && <p role="alert" className="mb-3 text-rose-300">{filterError}</p>}
          <label className="mb-5 block">Наличие<select value={draft.availability} onChange={(e) => setDraft({ ...draft, availability: e.target.value })}
            className="mt-1 min-h-11 w-full rounded-lg bg-slate-800 px-3"><option value="">Любое</option>
            <option value="IN_STOCK">В наличии</option><option value="OUT_OF_STOCK">Нет в наличии</option>
            <option value="STALE">Данные устарели</option><option value="UNKNOWN">Наличие неизвестно</option></select></label>
          <div className="flex gap-3"><button type="button" className="min-h-11 flex-1 rounded-lg bg-slate-700" onClick={reset}>Сбросить</button>
            <button className="min-h-11 flex-1 rounded-lg bg-blue-600">Показать</button></div>
        </form></div>}
      {!loaded ? <div aria-label="Загрузка товаров" className="grid gap-5 sm:grid-cols-2">{[0, 1, 2, 3].map((n) =>
        <div key={n} className="h-64 animate-pulse rounded-xl bg-slate-900" />)}</div>
      : items.length === 0 && !error ? <div className="py-12 text-center text-slate-300">
        <p>{Object.values(filters).some(Boolean) ? "По вашему запросу товары не найдены." : "Пока нет опубликованных товаров."}</p>
        {Object.values(filters).some(Boolean) && <button type="button" className="mt-4 min-h-11 underline" onClick={reset}>Сбросить фильтры</button>}
      </div> : <><section aria-label="Товары" className="grid gap-5 sm:grid-cols-2">{items.map((product) => {
        const cover = product.gallery.find((asset) => asset.type === "IMAGE" && asset.mediaUrl);
        return <button key={product.id} type="button" onClick={() => void open(product.slug)}
          className="min-h-11 overflow-hidden rounded-xl bg-slate-900 text-left hover:bg-slate-800">
          {cover?.mediaUrl ? <img src={cover.mediaUrl} alt={product.title} className="aspect-square w-full object-cover" />
            : <div className="flex aspect-square items-center justify-center text-slate-500">Watch</div>}
          <div className="p-4"><h2 className="text-lg font-semibold">{product.title}</h2>
            {product.brand && <p className="text-sm text-slate-300">{product.brand}</p>}
            <p className="mt-2 text-sm text-slate-300">От {price(product.priceFromMinor, product.currency)}</p>
            <p className="mt-2 text-sm">{labels[product.availability]}</p>
            {product.partnerView && <div className="mt-3 border-t border-slate-700 pt-2 text-sm">
              <p className="text-emerald-300">Комиссия: {price(product.partnerView.commissionFromMinor, product.currency)} – {price(product.partnerView.commissionToMinor, product.currency)}</p>
              {product.partnerView.referralEligible
                ? <p className="text-blue-300">Реферальная ссылка: доступна</p>
                : <p className="text-amber-300">{reasonLabel(product.partnerView.readOnlyReason) ?? "Реферальная ссылка недоступна"}</p>}
            </div>}</div></button>;
      })}</section>
        <nav aria-label="Страницы каталога" className="mt-7 flex items-center justify-center gap-5">
          <button type="button" disabled={page === 1} className="min-h-11 px-3 disabled:opacity-40" onClick={() => setPage(page - 1)}>Назад</button>
          <span>{page} / {Math.max(1, Math.ceil(total / limit))}</span>
          <button type="button" disabled={page * limit >= total} className="min-h-11 px-3 disabled:opacity-40" onClick={() => setPage(page + 1)}>Далее</button>
        </nav></>}
    </>}
  </div></main>;
}
