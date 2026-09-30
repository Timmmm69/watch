"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type CartLine = { variantId: string; productId: string; slug: string; title: string; sku: string;
  quantity: number; priceMinor: number; lineTotalMinor: number; availability: string; issues: string[] };
export type Cart = { id: string; currency: string; items: CartLine[]; totalMinor: number; canCheckout: boolean };
const messages: Record<string, string> = {
  ITEM_UNAVAILABLE: "Товар больше недоступен.", PRODUCT_NOT_ACTIVE: "Товар больше недоступен.",
  VARIANT_NOT_ACTIVE: "Вариант больше недоступен.", OUT_OF_STOCK: "Недостаточно товара в наличии. Уменьшите количество или удалите товар.",
  INVENTORY_STALE: "Данные о наличии устарели. Обновите корзину.", INVENTORY_UNKNOWN: "Наличие пока неизвестно. Обновите корзину.",
  CART_LINE_LIMIT_EXCEEDED: "В корзине может быть не больше 100 разных товаров.",
  VALIDATION_ERROR: "Количество должно быть целым числом от 1 до 99.",
  USER_BLOCKED: "Доступ заблокирован. Изменение корзины недоступно.",
  AUTH_REQUIRED: "Откройте приложение заново через Telegram.", SESSION_EXPIRED: "Откройте приложение заново через Telegram."
};
const money = (minor: number, currency: string) => new Intl.NumberFormat("ru-BY", { style: "currency", currency }).format(minor / 100);

export function useCart(csrfToken: string) {
  const [cart, setCart] = useState<Cart | null>(null);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const busy = useRef(new Set<string>());
  const [readOnly, setReadOnly] = useState(false);
  const token = useRef(csrfToken);
  const readSequence = useRef(0);
  const mounted = useRef(false);
  const request = useCallback(async (url: string, method = "GET", quantity?: number) => {
    const send = () => fetch(url, { method, credentials: "same-origin", cache: "no-store",
      headers: method === "GET" ? undefined : { "x-csrf-token": token.current,
        ...(quantity === undefined ? {} : { "content-type": "application/json" }) },
      body: quantity === undefined ? undefined : JSON.stringify({ quantity }) });
    let response = await send();
    if (response.status === 401) {
      const recovered = await fetch("/api/v1/auth/session", { credentials: "same-origin", cache: "no-store" });
      if (recovered.ok) { token.current = (await recovered.json() as { csrfToken: string }).csrfToken; response = await send(); }
    }
    const result = await response.json();
    if (!response.ok) {
      const code = result.error?.code as string;
      if (response.status === 401 || code === "USER_BLOCKED") setReadOnly(true);
      throw new Error(messages[code] ?? "Не удалось обновить корзину. Повторите попытку.");
    }
    return result as Cart;
  }, []);
  const refresh = useCallback(async () => {
    const sequence = ++readSequence.current;
    try {
      const current = await request("/api/v1/cart");
      if (mounted.current && sequence === readSequence.current) { setCart(current); setError(""); }
    } catch (cause) {
      if (mounted.current && sequence === readSequence.current) setError((cause as Error).message);
    }
  }, [request]);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void Promise.resolve().then(() => { if (active) void refresh(); });
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { active = false; mounted.current = false; ++readSequence.current; window.removeEventListener("focus", onFocus); };
  }, [refresh]);
  const mutate = async (key: string, quantity?: number, clear = false) => {
    if (busy.current.has(key) || readOnly) return;
    busy.current.add(key); setPending(new Set(busy.current));
    setErrors((previous) => ({ ...previous, [key]: "" }));
    ++readSequence.current;
    let succeeded = false;
    try {
      await request(clear ? "/api/v1/cart" : `/api/v1/cart/items/${encodeURIComponent(key)}`,
        quantity === undefined ? "DELETE" : "PUT", quantity);
      succeeded = true;
    } catch (cause) { if (mounted.current) setErrors((previous) => ({ ...previous, [key]: (cause as Error).message })); }
    finally {
      await refresh();
      busy.current.delete(key);
      if (mounted.current) setPending(new Set(busy.current));
    }
    return succeeded;
  };
  return { cart, error, errors, pending, readOnly, refresh, mutate };
}

export function CartScreen({ csrfToken }: { csrfToken: string }) {
  const { cart, error, errors, pending, readOnly, refresh, mutate } = useCart(csrfToken);
  const router = useRouter();
  useEffect(() => {
    const back = () => { if (window.history.length > 1) router.back(); else router.replace("/shop"); };
    const button = window.Telegram?.WebApp?.BackButton;
    button?.show(); button?.onClick(back);
    return () => { button?.offClick(back); button?.hide(); };
  }, [router]);
  return <main className="min-h-screen bg-slate-950 px-5 py-8 pb-36 text-slate-100"><div className="mx-auto max-w-4xl">
    <Link href="/shop" className="inline-flex min-h-11 items-center underline">← Продолжить покупки</Link>
    <h1 className="my-5 text-2xl font-semibold">Корзина</h1>
    {error && <p role="alert" className="mb-4 text-rose-300">{error}</p>}
    <button type="button" className="mb-4 min-h-11 underline" onClick={() => void refresh()}>Обновить корзину</button>
    {!cart && !error && <div aria-label="Загрузка корзины" className="space-y-4">{[0, 1, 2].map((i) => <div key={i} className="h-32 animate-pulse rounded-xl bg-slate-900" />)}</div>}
    {cart?.items.length === 0 && <section className="py-10"><p className="text-xl">Корзина пуста</p>
      <Link href="/shop" className="mt-5 inline-flex min-h-11 items-center rounded-lg bg-blue-600 px-4">Перейти в каталог</Link></section>}
    {cart && cart.items.length > 0 && <>
      <ul className="space-y-4">{cart.items.map((item) => <li key={item.variantId} className="rounded-xl bg-slate-900 p-4">
        <h2 className="text-lg font-semibold"><Link href={`/shop?product=${encodeURIComponent(item.slug)}`}>{item.title}</Link></h2>
        <p className="text-sm text-slate-400">Артикул: {item.sku}</p>
        <p className="my-2">{money(item.priceMinor, cart.currency)} за шт. · {money(item.lineTotalMinor, cart.currency)}</p>
        {item.issues.map((issue) => <p key={issue} className="mb-2 text-amber-300">{messages[issue]}</p>)}
        {errors[item.variantId] && <p role="alert" className="mb-2 text-rose-300">{errors[item.variantId]}</p>}
        <div className="flex flex-wrap items-center gap-3" aria-label={`Количество ${item.sku}`}>
          <button type="button" aria-label={`Уменьшить ${item.sku}`} disabled={readOnly || pending.has(item.variantId) || item.quantity <= 1}
            className="min-h-11 min-w-11 rounded-lg bg-slate-700 disabled:opacity-40" onClick={() => void mutate(item.variantId, item.quantity - 1)}>−</button>
          <span aria-live="polite">{item.quantity}</span>
          <button type="button" aria-label={`Увеличить ${item.sku}`} disabled={readOnly || pending.has(item.variantId) || item.quantity >= 99 || item.issues.length > 0}
            className="min-h-11 min-w-11 rounded-lg bg-slate-700 disabled:opacity-40" onClick={() => void mutate(item.variantId, item.quantity + 1)}>+</button>
          <button type="button" disabled={readOnly || pending.has(item.variantId)} className="min-h-11 px-3 underline disabled:opacity-40"
            onClick={() => void mutate(item.variantId)}>Удалить {item.sku}</button>
          {pending.has(item.variantId) && <span role="status" className="animate-pulse">Сохранение…</span>}
        </div>
      </li>)}</ul>
      <button type="button" disabled={readOnly || pending.has("clear")} className="mt-4 min-h-11 underline disabled:opacity-40"
        onClick={() => void mutate("clear", undefined, true)}>{pending.has("clear") ? "Очистка…" : "Очистить корзину"}</button>
      {errors.clear && <p role="alert" className="text-rose-300">{errors.clear}</p>}
      <section className="fixed inset-x-0 bottom-0 border-t border-slate-700 bg-slate-950 px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-4xl"><p className="text-lg">Итого: {money(cart.totalMinor, cart.currency)}</p>
          {!cart.canCheckout && <p className="text-sm text-amber-300">Устраните проблемы товаров перед оформлением.</p>}
          <button type="button" disabled={readOnly || !cart.canCheckout || pending.size > 0}
            onClick={() => router.push("/checkout")} className="mt-2 min-h-11 w-full rounded-lg bg-blue-600 disabled:opacity-40">Оформить заказ</button>
        </div>
      </section>
    </>}
  </div></main>;
}

export function ProductCartActions({ variants, currency, csrfToken }: {
  variants: { id: string; sku: string; priceMinor: number; availability: string }[]; currency: string; csrfToken: string
}) {
  const { cart, error, errors, pending, readOnly, mutate } = useCart(csrfToken);
  const [selectedId, setSelectedId] = useState(variants[0]?.id ?? "");
  const [added, setAdded] = useState(false);
  const selected = variants.find((variant) => variant.id === selectedId);
  const quantity = cart?.items.find((item) => item.variantId === selectedId)?.quantity ?? 0;
  return <section className="sticky bottom-0 mt-5 rounded-xl bg-slate-900 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]" aria-label="Покупка товара">
    <label>Вариант товара<select className="ml-3 min-h-11 rounded-lg bg-slate-800 px-3" value={selectedId}
      onChange={(event) => { setSelectedId(event.target.value); setAdded(false); }}>
      {variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.sku}</option>)}
    </select></label>
    {selected && <p className="my-3">{money(selected.priceMinor, currency)}</p>}
    <button type="button" disabled={!cart || readOnly || !selected || selected.availability !== "IN_STOCK" || quantity >= 99 || pending.has(selectedId)}
      className="min-h-11 rounded-lg bg-blue-600 px-4 disabled:opacity-40" onClick={() => {
        setAdded(false); void mutate(selectedId, quantity + 1).then((success) => setAdded(Boolean(success)));
      }}>{pending.has(selectedId) ? "Добавление…" : "Добавить в корзину"}</button>
    {selected && selected.availability !== "IN_STOCK" && <p className="mt-2 text-amber-300">Товар сейчас недоступен для покупки.</p>}
    {quantity >= 99 && <p className="mt-2 text-amber-300">Максимум 99 штук одного товара.</p>}
    {added && <p role="status" className="mt-2 text-emerald-300">Товар добавлен в корзину.</p>}
    {(errors[selectedId] || error) && <p role="alert" className="mt-2 text-rose-300">{errors[selectedId] || error}</p>}
    <Link href="/cart" className="ml-4 inline-flex min-h-11 items-center underline">Корзина ({cart?.items.length ?? 0})</Link>
  </section>;
}

export function CartIndicator({ csrfToken }: { csrfToken: string }) {
  const { cart } = useCart(csrfToken);
  return <Link href="/cart" className="inline-flex min-h-11 items-center underline">Корзина{cart ? ` (${cart.items.length})` : ""}</Link>;
}
