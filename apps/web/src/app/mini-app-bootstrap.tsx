"use client";

import { useEffect, useRef, useState } from "react";

interface AuthResponse {
  user: { firstName: string };
  launchTarget?: string;
}

interface CatalogAsset {
  id: string;
  type: "IMAGE" | "VIDEO" | "TEXT";
  mediaUrl: string | null;
  text: string | null;
}

interface CatalogProduct {
  id: string;
  slug: string;
  title: string;
  description: string;
  priceFromMinor: number | null;
  currency: string;
  gallery: CatalogAsset[];
}

interface CatalogDetail extends CatalogProduct {
  variants: { id: string; sku: string; priceMinor: number; currency: string }[];
}

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData: string; ready: () => void; expand: () => void } };
  }
}

export function MiniAppBootstrap() {
  const started = useRef(false);
  const [state, setState] = useState<{ name?: string; error?: string }>({});
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [detail, setDetail] = useState<CatalogDetail | null>(null);
  const [catalogError, setCatalogError] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const webApp = window.Telegram?.WebApp;
    webApp?.ready();
    webApp?.expand();
    const initData = webApp?.initData;
    const reload = performance.getEntriesByType("navigation").some((entry) =>
      (entry as PerformanceNavigationTiming).type === "reload");
    const endpoint = initData ? "/api/v1/auth/telegram" : reload ? "/api/v1/auth/session" : null;
    if (!endpoint) {
      setState({ error: "Откройте приложение через Telegram." });
      return;
    }
    void fetch(endpoint, {
      method: initData ? "POST" : "GET",
      credentials: "same-origin",
      headers: initData ? { "content-type": "application/json" } : undefined,
      body: initData ? JSON.stringify({ initData }) : undefined,
      cache: "no-store"
    }).then(async (response) => {
      if (!response.ok) throw new Error("Authentication failed");
      return response.json() as Promise<AuthResponse>;
    }).then((result) => {
      if (result.launchTarget && window.location.pathname === "/") {
        window.history.replaceState(null, "", result.launchTarget);
      }
      setState({ name: result.user.firstName });
      return fetch("/api/v1/catalog/products?page=1&limit=20", { credentials: "same-origin", cache: "no-store" });
    }).then(async (response) => {
      if (!response.ok) throw new Error("Catalog unavailable");
      const catalog = await response.json() as { items: CatalogProduct[] };
      setProducts(catalog.items);
      setCatalogLoaded(true);
    }).catch((error) => {
      if (error instanceof Error && error.message === "Catalog unavailable") {
        setCatalogError(true);
        setCatalogLoaded(true);
      }
      else setState({ error: "Не удалось войти. Откройте приложение заново через Telegram." });
    });
  }, []);

  const openProduct = async (slug: string) => {
    setCatalogError(false);
    try {
      const response = await fetch(`/api/v1/catalog/products/${encodeURIComponent(slug)}`, {
        credentials: "same-origin", cache: "no-store"
      });
      if (!response.ok) throw new Error("Catalog unavailable");
      setDetail(await response.json() as CatalogDetail);
    } catch { setCatalogError(true); }
  };

  const price = (minor: number | null, currency: string) =>
    minor === null ? "Цена уточняется" : new Intl.NumberFormat("ru-BY", {
      style: "currency", currency
    }).format(minor / 100);

  const cover = (product: CatalogProduct) => product.gallery.find((asset) => asset.type === "IMAGE" && asset.mediaUrl);

  if (!state.name) return <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
    <div className="text-center">
      <h1 className="text-2xl font-semibold">Watch</h1>
      <p className="mt-4">{state.error ?? "Вход через Telegram…"}</p>
    </div>
  </main>;

  return <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100">
    <div className="mx-auto max-w-4xl">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Watch</h1>
        <span className="text-sm text-slate-400">Здравствуйте, {state.name}</span>
      </header>
      {catalogError && <p role="alert" className="mb-5 text-rose-300">Не удалось загрузить каталог. Попробуйте открыть магазин ещё раз.</p>}
      {detail ? <section>
        <button type="button" className="mb-5 text-sm text-slate-300 underline" onClick={() => setDetail(null)}>← Все товары</button>
        <h2 className="mb-2 text-3xl font-semibold">{detail.title}</h2>
        <p className="mb-5 text-slate-300">{detail.description}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {detail.gallery.map((asset) => asset.type === "IMAGE" && asset.mediaUrl
            ? <img key={asset.id} src={asset.mediaUrl} alt={detail.title} className="w-full rounded-xl bg-slate-900 object-contain" />
            : asset.type === "VIDEO" && asset.mediaUrl
              ? <video key={asset.id} src={asset.mediaUrl} controls className="w-full rounded-xl bg-slate-900" />
              : asset.text ? <p key={asset.id} className="rounded-xl bg-slate-900 p-4">{asset.text}</p> : null)}
        </div>
        <p className="mt-6 text-lg font-medium">От {price(detail.priceFromMinor, detail.currency)}</p>
      </section> : !catalogLoaded ? <p className="text-slate-300">Загрузка товаров…</p>
        : products.length === 0 && !catalogError ? <p className="text-slate-300">Пока нет опубликованных товаров.</p>
        : <section className="grid gap-5 sm:grid-cols-2" aria-label="Товары">
          {products.map((product) => <button key={product.id} type="button"
            onClick={() => void openProduct(product.slug)}
            className="overflow-hidden rounded-xl bg-slate-900 text-left transition hover:bg-slate-800">
            {cover(product)?.mediaUrl ? <img src={cover(product)!.mediaUrl!} alt="" className="aspect-square w-full object-cover" />
              : <div className="flex aspect-square items-center justify-center text-slate-500">Watch</div>}
            <div className="p-4">
              <h2 className="text-lg font-semibold">{product.title}</h2>
              <p className="mt-2 text-sm text-slate-300">От {price(product.priceFromMinor, product.currency)}</p>
            </div>
          </button>)}
        </section>}
    </div>
  </main>;
}
