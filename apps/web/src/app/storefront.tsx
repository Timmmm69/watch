"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CartIndicator, ProductCartActions } from "./cart-client";
import { ShopContact } from "./shop-contact";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { partnerReacceptUrl } from "./partner-client";

type Availability = "IN_STOCK" | "OUT_OF_STOCK" | "STALE" | "UNKNOWN";
type PartnerViewReason = "PARTNER_BLOCKED" | "TERMS_REACCEPT_REQUIRED" | null;
type Asset = { id: string; type: string; purpose?: string; mediaUrl: string | null; text: string | null };
type ProductCardPartnerView = { commissionFromMinor: number; commissionToMinor: number; referralEligible: boolean; readOnlyReason: PartnerViewReason };
type Product = { id: string; slug: string; title: string; description: string; brand: string | null;
  priceFromMinor: number | null; currency: string; availability: Availability;
  gallery: Asset[]; partnerView?: ProductCardPartnerView };
type VariantPartnerView = { id: string; commissionUnitMinor: number; referralEligible: boolean; readOnlyReason: PartnerViewReason };
type Detail = Product & { variants: { id: string; sku: string; priceMinor: number; availability: Availability; sellable?: number; dropshipPriceMinor?: number | null }[];
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

export function Storefront({ name, csrfToken, partner, partnerTermsReacceptRequired, nativeCommerce = false, supportContact }: {
  name: string; csrfToken: string; partner: { id: string; status: "ACTIVE" | "BLOCKED" } | null;
  partnerTermsReacceptRequired: boolean;
  nativeCommerce?: boolean; supportContact?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const partnerMode = Boolean(partner && searchParams.get("mode") === "partner");
  const productSlug = searchParams.get("product");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(productSlug);
  const [detailMode, setDetailMode] = useState(partnerMode);
  const [catalogMode, setCatalogMode] = useState(partnerMode);
  const [items, setItems] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [detailResult, setDetail] = useState<Detail | null>(null);
  const detail = detailMode === partnerMode ? detailResult : null;
  const [draft, setDraft] = useState<Filters>(empty);
  const [filters, setFilters] = useState<Filters>(empty);
  const [drawer, setDrawer] = useState(false);
  const filterDialog = useRef<HTMLDialogElement>(null);
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
    const dialog = filterDialog.current;
    if (!drawer) { dialog?.close(); return; }
    dialog?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { dialog?.close(); document.body.style.overflow = overflow; };
  }, [drawer]);

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
    if (partnerMode) params.set("view", "partner");
    void fetch(`/api/v1/catalog/products?${params}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ items: Product[]; total: number }>; })
      .then((result) => { if (!controller.signal.aborted) { setItems(result.items); setTotal(result.total); setCatalogMode(partnerMode); setLoaded(true); } })
      .catch(() => { if (!controller.signal.aborted) { setError(true); setLoaded(true); } });
    return () => controller.abort();
  }, [filters, page, retry, partnerMode]);

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
  const open = (slug: string) => setSelectedSlug(slug);

  useEffect(() => {
    if (productSlug) setSelectedSlug(productSlug);
  }, [productSlug]);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null); setError(false); setLink(""); setLinkError("");
    if (selectedSlug) {
      void fetch(`/api/v1/catalog/products/${encodeURIComponent(selectedSlug)}${partnerMode ? "?view=partner" : ""}`,
        { credentials: "same-origin", cache: "no-store", signal: controller.signal })
        .then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<Detail>; })
        .then((result) => { if (!controller.signal.aborted) { setDetail(result); setDetailMode(partnerMode); } })
        .catch(() => { if (!controller.signal.aborted) setError(true); });
    }
    return () => controller.abort();
  }, [selectedSlug, partnerMode, retry]);

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

  return <main className="app-shell min-h-dvh bg-canvas text-ink"><div className="mx-auto max-w-5xl">
    <header className="shop-header mb-4 flex flex-wrap items-center justify-between gap-3"><h1>Watch</h1>
      <span className="min-w-0 break-words text-sm text-muted">Здравствуйте, {name}</span></header>
    <nav className="mb-5 flex flex-wrap gap-4">
      {!partnerMode && <Link className="min-h-11 underline" href="/orders">Мои заказы</Link>}
      {partner ? <Link className="min-h-11 underline" href="/partner">Партнёрский кабинет</Link>
        : <Link className="min-h-11 underline" href="/partner/onboarding">Продавать с нами</Link>}
      {partnerTermsReacceptRequired && <Link className="min-h-11 underline" href="/partner/onboarding">Принять новые условия</Link>}
    </nav>
    {!partnerMode && !detail && <CartIndicator csrfToken={csrfToken} />}
    {partner && <Link className="min-h-11 underline" href={partnerMode ? "/shop" : "/shop?mode=partner"}>{partnerMode ? "Покупать для себя" : "Рабочий режим продавца"}</Link>}
    {!partnerMode && !detail && <p className="mb-5 text-ink-secondary">Выберите часы и оформите покупку в корзине. Вопросы по товару и доставке можно задать магазину.</p>}
    {!partnerMode && new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("referral") === "unavailable" && <p role="status" className="mb-5 text-warning">Ссылка недоступна. Можно купить напрямую.</p>}
    {partner?.status === "BLOCKED" && <p role="status" className="mb-5 text-warning">Новые заказы и заявки на выплату недоступны. Каталог и история доступны для просмотра.</p>}
    {partnerMode && partner && !detail && <section className="app-panel mb-6" aria-label="Партнёрская ссылка">
      <h2 className="text-lg font-bold">Ваша ссылка на магазин</h2>
      {partner.status === "ACTIVE" && !partnerTermsReacceptRequired
        ? <button type="button" disabled={linkLoading} className="app-button app-button-primary mt-3 min-h-11 px-4 disabled:opacity-50"
            onClick={() => void copyReferral(null)}>Скопировать ссылку на магазин</button>
        : <p className="mt-2 text-warning">{partner.status === "BLOCKED" ? "Партнёр заблокирован" : "Требуется принять новые условия"}</p>}
      {link && <p className="mt-2 break-all text-sm text-success">Ссылка скопирована: {link}</p>}
      {linkError && <p role="alert" className="mt-2 text-danger">{linkError}</p>}
    </section>}
    {error && <div role="alert" className="mb-5 flex items-center gap-4 text-danger">Не удалось загрузить каталог.
      <button type="button" className="min-h-11 underline" onClick={() => setRetry((n) => n + 1)}>Повторить</button></div>}
    {selectedSlug && !detail ? <p role="status">Загрузка товара…</p> : detail ? <section>
      <button type="button" className="mb-5 min-h-11 underline" onClick={() => {
        setSelectedSlug(null); setDetail(null); setLink(""); setLinkError("");
        const params = new URLSearchParams(searchParams);
        params.delete("product");
        router.replace(`/shop${params.size ? `?${params}` : ""}`);
      }}>← Все товары</button>
      <h2 className="mb-2 text-3xl font-bold">{detail.title}</h2>
      {detail.brand && <p className="text-ink-secondary">{detail.brand}</p>}
      <p className="mb-5 text-ink-secondary">{detail.description}</p>
      <div className="grid gap-4 sm:grid-cols-2">{detail.gallery.map((asset) => asset.type === "IMAGE" && asset.mediaUrl
        ? <img key={asset.id} src={asset.mediaUrl} alt={detail.title} className="w-full rounded-xl bg-surface object-contain" />
        : asset.type === "VIDEO" && asset.mediaUrl ? <video key={asset.id} src={asset.mediaUrl} controls className="w-full rounded-xl bg-surface" />
          : asset.text ? <p key={asset.id} className="rounded-xl bg-surface p-4">{asset.text}</p> : null)}</div>
      {partnerMode && detail.partnerView && <div className="app-panel mt-6">
        <h3 className="mb-3 text-lg font-bold">Материалы и условия для продажи</h3>
        {detail.partnerView.referralEligible
          ? <button type="button" disabled={linkLoading} className="app-button app-button-primary mb-3 min-h-11 px-4 disabled:opacity-50"
              onClick={() => void copyReferral(detail.id)}>Скопировать ссылку на товар</button>
          : <p className="mb-3 text-warning">{reasonLabel(detail.partnerView.readOnlyReason) ?? "Реферальная ссылка недоступна"}</p>}
        {link && <p className="mb-3 break-all text-sm text-success">Ссылка скопирована: {link}</p>}
        {linkError && <p role="alert" className="mb-3 text-danger">{linkError}</p>}
        <table className="w-full text-left text-sm"><thead><tr className="text-muted"><th className="pb-2">Артикул</th><th className="pb-2">Комиссия по ссылке</th></tr></thead><tbody>
          {detail.partnerView.variants.map((variant) => <tr key={variant.id} className="border-t border-hairline">
            <td className="py-2">{detail.variants.find((v) => v.id === variant.id)?.sku ?? variant.id}</td>
            <td className="py-2 text-success">{price(variant.commissionUnitMinor, detail.currency)}</td>
          </tr>)}
        </tbody></table>
        {detail.partnerView.assets.length > 0 && <div className="mt-4 grid gap-4 sm:grid-cols-2">{detail.partnerView.assets.map((asset) => asset.type === "IMAGE" && asset.mediaUrl
          ? <img key={asset.id} src={asset.mediaUrl} alt="Партнёрский материал" className="w-full rounded-xl bg-canvas object-contain" />
          : asset.type === "VIDEO" && asset.mediaUrl ? <video key={asset.id} src={asset.mediaUrl} controls className="w-full rounded-xl bg-canvas" />
            : asset.text ? <p key={asset.id} className="rounded-xl bg-canvas p-4">{asset.text}</p> : null)}</div>}
      </div>}
      <p className="mt-6 text-lg font-medium">{partnerMode ? "Розничная цена — от " : "От "}{price(detail.priceFromMinor, detail.currency)}</p>
      <p className="mt-2">{labels[detail.availability]}</p>
      {!partnerMode ? <section className="mt-5 space-y-3" aria-label="Варианты товара">
        <p>Показана цена магазина. Оформите заказ самостоятельно или задайте вопрос магазину.</p>
        {detail.variants.map((variant) => <section key={variant.id} className="app-panel space-y-3">
          <h3 className="font-bold">{variant.sku} · {price(variant.priceMinor, detail.currency)}</h3><p>{labels[variant.availability]}</p>
          <ShopContact contact={supportContact} label="Задать вопрос магазину" draft={`Здравствуйте! Хочу уточнить покупку часов «${detail.title}», вариант ${variant.sku}. Цена каталога: ${price(variant.priceMinor, detail.currency)}. Подскажите условия доставки.`} />
        </section>)}
        {detail.variants.length > 0 && <ProductCartActions variants={detail.variants} currency={detail.currency} csrfToken={csrfToken} />}
        {detail.variants.length === 0 && <CartIndicator csrfToken={csrfToken} />}
      </section> : <section className="mt-5 space-y-3" aria-label="Выбор варианта часов">{detail.variants.map((variant) => <div key={variant.id} className="app-panel">
        <p>{variant.sku} · Розничная цена: {price(variant.priceMinor, detail.currency)}</p>
        <p>Цена магазина для вас: {price(variant.dropshipPriceMinor ?? null, detail.currency)} · Доступно: {variant.sellable ?? 0}</p>
        {detail.partnerView?.variants.find((item) => item.id === variant.id) && <p className="text-success">Комиссия за самостоятельную покупку по вашей ссылке: {price(detail.partnerView.variants.find((item) => item.id === variant.id)!.commissionUnitMinor, detail.currency)}</p>}
        {variant.dropshipPriceMinor != null && variant.availability === "IN_STOCK" && partner?.status === "ACTIVE" && !partnerTermsReacceptRequired && !detail.partnerView?.readOnlyReason
          ? <Link className="inline-flex min-h-11 items-center underline" href={`/checkout?mode=partner&product=${encodeURIComponent(detail.slug)}&variant=${variant.id}`}>Оформить заказ клиенту</Link>
          : <p>{detail.partnerView?.readOnlyReason === "PARTNER_BLOCKED" ? "Новые заказы недоступны. Обратитесь в поддержку." : partnerTermsReacceptRequired || detail.partnerView?.readOnlyReason === "TERMS_REACCEPT_REQUIRED" ? "Примите текущие условия в кабинете." : "Оформление недоступно."}</p>}
      </div>)}</section>}
    </section> : <>
      <h2 className="mb-4 text-2xl font-bold tracking-tight">Каталог часов</h2>
      <form onSubmit={apply} className="shop-search mb-5 flex gap-2"><label className="sr-only" htmlFor="shop-search">Поиск товаров</label>
        <input id="shop-search" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          placeholder="Поиск товаров" maxLength={100} className="app-input min-h-11 min-w-0 flex-1" />
        <button className="app-button app-button-primary min-h-11 px-4">Найти товары</button>
        <button type="button" className="app-button min-h-11 px-4" onClick={() => setDrawer(true)}>Фильтры</button></form>
      {categories.length > 0 && <nav aria-label="Категории" className="mb-5 flex gap-2 overflow-x-auto pb-2">
        {[{ id: "", slug: "", name: "Все" }, ...categories].map((category) => <button key={category.id} type="button"
          aria-pressed={filters.category === category.slug} className="shop-category min-h-11 shrink-0 rounded-full px-4"
          onClick={() => { setFilters({ ...filters, category: category.slug }); setDraft({ ...draft, category: category.slug }); setPage(1); }}>{category.name}</button>)}
      </nav>}
      <dialog ref={filterDialog} aria-labelledby="catalog-filters-title" onCancel={() => setDrawer(false)}
        onClick={(event) => { if (event.target === event.currentTarget) setDrawer(false); }}
        className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none items-end border-0 bg-scrim p-0 text-ink open:flex sm:items-center sm:justify-center">
        <form onSubmit={apply} aria-label="Фильтры каталога" className="app-panel shop-modal max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-b-none sm:rounded-2xl">
          <div className="mb-4 flex items-center justify-between"><h2 id="catalog-filters-title" className="text-xl font-bold">Фильтры</h2>
            <button type="button" className="min-h-11 px-3" onClick={() => setDrawer(false)}>Закрыть</button></div>
          <label className="mb-3 block">Бренд<input value={draft.brand} maxLength={120} onChange={(e) => setDraft({ ...draft, brand: e.target.value })}
            className="app-input mt-1 min-h-11 w-full" /></label>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <label>Цена от<input type="number" min="0" max="21474836.47" step="0.01" value={draft.minPrice} onChange={(e) => setDraft({ ...draft, minPrice: e.target.value })}
              className="app-input mt-1 min-h-11 w-full" /></label>
            <label>Цена до<input type="number" min="0" max="21474836.47" step="0.01" value={draft.maxPrice} onChange={(e) => setDraft({ ...draft, maxPrice: e.target.value })}
              className="app-input mt-1 min-h-11 w-full" /></label></div>
          {filterError && <p role="alert" className="mb-3 text-danger">{filterError}</p>}
          <label className="mb-5 block">Наличие<select value={draft.availability} onChange={(e) => setDraft({ ...draft, availability: e.target.value })}
            className="app-input mt-1 min-h-11 w-full"><option value="">Любое</option>
            <option value="IN_STOCK">В наличии</option><option value="OUT_OF_STOCK">Нет в наличии</option>
            {!nativeCommerce && <><option value="STALE">Наличие уточняется: данные обновляются</option><option value="UNKNOWN">Наличие уточняется</option></>}</select></label>
          <div className="flex gap-3"><button type="button" className="app-button min-h-11 flex-1" onClick={reset}>Сбросить</button>
            <button className="app-button app-button-primary min-h-11 flex-1">Показать товары</button></div>
        </form></dialog>
      {!loaded || catalogMode !== partnerMode ? <div aria-label="Загрузка товаров" className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((n) =>
        <div key={n} className="h-64 animate-pulse rounded-xl bg-surface" />)}</div>
      : items.length === 0 && !error ? <div className="py-12 text-center text-ink-secondary">
        <p>{Object.values(filters).some(Boolean) ? "По выбранным условиям ничего не найдено." : "Пока нет опубликованных товаров."}</p>
        {Object.values(filters).some(Boolean) && <button type="button" className="mt-4 min-h-11 underline" onClick={reset}>Сбросить фильтры</button>}
      </div> : <><section aria-label="Товары" className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{items.map((product) => {
        const cover = product.gallery.find((asset) => asset.type === "IMAGE" && asset.mediaUrl);
        return <button key={product.id} type="button" onClick={() => void open(product.slug)}
          className="shop-product min-h-11 overflow-hidden text-left">
          {cover?.mediaUrl ? <img src={cover.mediaUrl} alt={product.title} className="shop-product-media aspect-square w-full object-cover" />
            : <div className="shop-product-media flex aspect-square items-center justify-center text-muted">Watch</div>}
          <div className="p-5"><h2 className="text-lg font-bold">{product.title}</h2>
            {product.brand && <p className="mt-1 text-sm text-muted">{product.brand}</p>}
            <p className="shop-product-price mt-4">{partnerMode ? "Розничная цена — от " : "От "}{price(product.priceFromMinor, product.currency)}</p>
            <p className="mt-2 text-sm text-muted">{labels[product.availability]}</p>
            {partnerMode && product.partnerView && <div className="mt-3 border-t border-hairline pt-2 text-sm">
              <p className="text-success">Комиссия: {price(product.partnerView.commissionFromMinor, product.currency)} – {price(product.partnerView.commissionToMinor, product.currency)}</p>
              {product.partnerView.referralEligible
                ? <p className="text-link">Реферальная ссылка: доступна</p>
                : <p className="text-warning">{reasonLabel(product.partnerView.readOnlyReason) ?? "Реферальная ссылка недоступна"}</p>}
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
