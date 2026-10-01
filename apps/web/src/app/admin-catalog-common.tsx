"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { cloneElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";

export const inputClass = "w-full rounded border border-slate-600 bg-slate-900 p-2";
export const buttonClass = "min-h-11 rounded border border-slate-600 px-3 py-2 disabled:opacity-40";
export type PageData<T> = { items: T[]; page: number; limit: number; total: number };
export type Category = { id: string; name: string; slug: string; sortOrder: number; status: string; updatedAt: string };
export type Variant = { id: string; sku: string; status: string; attributes: Record<string, unknown>; priceMinor: number;
  currency: string; partnerCommissionUnitMinor: number; supplierSettlementUnitMinor: number | null; inventoryExternalKey: string;
  updatedAt: string; inventory: { safetyBuffer: number } | null };
export type Asset = { id: string; type: string; purpose: string; status: string; text: string | null; mediaUrl: string | null;
  sortOrder: number; variantId: string | null; sizeBytes: number | null };
export type Product = { id: string; title: string; slug: string; description: string; brand: string | null;
  status: string; specifications: Record<string, unknown>; updatedAt: string; categories: Category[]; variants: Variant[]; assets: Asset[] };
export type ProductCard = Omit<Product, "categories" | "variants" | "assets"> & {
  categories: Pick<Category, "id" | "name" | "status">[]; variants: Pick<Variant, "id" | "sku" | "status" | "priceMinor" | "currency">[];
  availability: string };
export const availabilityLabels: Record<string, string> = { IN_STOCK: "В наличии", OUT_OF_STOCK: "Нет в наличии", STALE: "Устаревшие остатки", UNKNOWN: "Остатки неизвестны" };

export function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return <div className="space-y-1"><label className="block" htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>;
}
export function jsonObject(value: FormDataEntryValue | null): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(String(value || "{}"));
    if (result && typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>;
  } catch { /* Show one actionable validation error below. */ }
  throw new Error("Введите JSON-объект, например {\"цвет\":\"чёрный\"}.");
}
export function StatusOptions({ current }: { current: string }) {
  return <>{[...new Set([current, "ACTIVE", "ARCHIVED"])].map(status => <option key={status}>{status}</option>)}</>;
}
export function Pagination({ data, onPage }: { data: { page: number; limit: number; total: number }; onPage: (page: number) => void }) {
  return <nav className="my-4 flex items-center gap-4" aria-label="Страницы"><button className={buttonClass} disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>Назад</button>
    <span>Страница {data.page}</span><button className={buttonClass} disabled={data.page * data.limit >= data.total} onClick={() => onPage(data.page + 1)}>Далее</button></nav>;
}
export function AdminCatalogLayout({ title, back = "/admin", children }: { title: string; back?: string; children: ReactNode }) {
  const router = useRouter();
  useEffect(() => {
    const button = window.Telegram?.WebApp?.BackButton;
    const goBack = () => router.push(back);
    button?.show(); button?.onClick(goBack);
    return () => { button?.offClick(goBack); button?.hide(); };
  }, [router, back]);
  return <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100"><div className="mx-auto max-w-5xl space-y-5">
    <nav className="flex flex-wrap gap-5"><Link href="/admin">Панель администратора</Link><Link href="/admin/catalog">Каталог</Link>
      <Link href="/admin/inventory">Инвентарь</Link><Link href="/admin/orders?reconciliationPending=true">Заказы на сверку</Link></nav>
    <h1 className="text-2xl font-semibold">{title}</h1>{children}
  </div></main>;
}

// Mutations remain server-authorized and audited by the existing APIs.
export function useAdminCatalogApi(csrfToken: string) {
  const token = useRef(csrfToken);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useCallback(async <T,>(url: string, method = "GET", payload?: object | FormData, signal?: AbortSignal): Promise<T> => {
    const multipart = payload instanceof FormData;
    const send = () => fetch(url, { method, credentials: "same-origin", cache: "no-store", signal,
      headers: method === "GET" ? undefined : { "x-csrf-token": token.current, ...(multipart ? {} : { "content-type": "application/json" }) },
      body: payload === undefined ? undefined : multipart ? payload : JSON.stringify(payload) });
    let response = await send();
    if (response.status === 401) {
      const recovery = await fetch("/api/v1/auth/session", { credentials: "same-origin", cache: "no-store", signal });
      if (recovery.ok) { token.current = (await recovery.json()).csrfToken; response = await send(); }
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) setDenied(true);
      const code = body.error?.code;
      const message = code === "STORAGE_UNAVAILABLE" ? "Хранилище недоступно. Файл не добавлен. Повторите загрузку."
        : code === "SYNC_ALREADY_RUNNING" ? "Синхронизация уже выполняется. Обновите историю запусков."
        : response.status === 401 ? "Откройте приложение заново через Telegram."
        : response.status === 403 ? "Доступ запрещён."
        : response.status === 404 ? "Запись не найдена."
        : `${code ?? "Ошибка сервера"}: ${body.error?.message ?? "Не удалось выполнить запрос. Повторите попытку."}`;
      const details = body.error?.details;
      throw new Error(message + (details && Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""));
    }
    return body as T;
  }, []);
  const mutate = async (action: () => Promise<void>, confirmation?: string) => {
    if (lock.current || denied || (confirmation && !window.confirm(confirmation))) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось выполнить запрос. Повторите попытку."); }
    finally { lock.current = false; setBusy(false); }
  };
  return { request, mutate, busy, denied, error, setError, notice, setNotice };
}

export async function readCategories(request: <T>(url: string, method?: string, payload?: object | FormData, signal?: AbortSignal) => Promise<T>, signal: AbortSignal) {
  const categories: Category[] = [];
  let page = 1;
  for (;;) {
    const result = await request<PageData<Category>>(`/api/v1/admin/categories?page=${page}&limit=100`, "GET", undefined, signal);
    categories.push(...result.items);
    if (page * result.limit >= result.total) return categories;
    page++;
  }
}
