"use client";

import Link from "next/link";
import { BuyerActionBar, BuyerEmpty, BuyerHeader } from "./buyer-ui";
import { ShopIcon } from "./shop-icon";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type CartLine = { variantId: string; productId: string; slug: string; title: string; sku: string;
  quantity: number; priceMinor: number; lineTotalMinor: number; availability: string; issues: string[] };
export type Cart = { id: string; currency: string; items: CartLine[]; totalMinor: number; canCheckout: boolean };
type PurchaseContext = { channel: "DIRECT" | "REFERRAL"; touchId: string | null; expiresAt: string | null;
  referralProductId: string | null; partnerDisplayName: string | null; available?: boolean };
type ReferralOffer = Omit<PurchaseContext, "channel">;
export type ContextualCart = Cart & { purchaseContext?: PurchaseContext; pendingReferral?: ReferralOffer | null };
const messages: Record<string, string> = {
  ITEM_UNAVAILABLE: "Этот товар больше нельзя заказать. Удалите его из корзины.", PRODUCT_NOT_ACTIVE: "Этот товар больше нельзя заказать. Удалите его из корзины.",
  VARIANT_NOT_ACTIVE: "Выбранный вариант товара больше недоступен. Удалите его из корзины.", OUT_OF_STOCK: "Недостаточно товара в наличии. Уменьшите количество или удалите позицию.",
  INVENTORY_STALE: "Не удалось подтвердить наличие. Обновите корзину позже.", INVENTORY_UNKNOWN: "Наличие не подтверждено. Попробуйте обновить корзину позже.",
  CART_LINE_LIMIT_EXCEEDED: "В корзине может быть не более 100 разных товаров.",
  VALIDATION_ERROR: "Количество должно быть целым числом от 1 до 99.",
  USER_BLOCKED: "Ваш аккаунт заблокирован. Изменять корзину нельзя.",
  AUTH_REQUIRED: "Откройте приложение заново через Telegram.", SESSION_EXPIRED: "Откройте приложение заново через Telegram."
};
const money = (minor: number, currency: string) => new Intl.NumberFormat("ru-BY", { style: "currency", currency }).format(minor / 100);

export function useCart(csrfToken: string) {
  const [cart, setCart] = useState<ContextualCart | null>(null);
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
    return result as ContextualCart;
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
  const [contextError, setContextError] = useState("");
  const [contextPending, setContextPending] = useState(false);
  const [contextRetry, setContextRetry] = useState<"DIRECT" | "REFERRAL" | null>(null);
  const contextBusy = useRef(false);
  useEffect(() => {
    const back = () => { if (window.history.length > 1) router.back(); else router.replace("/shop"); };
    const button = window.Telegram?.WebApp?.BackButton;
    button?.show(); button?.onClick(back);
    return () => { button?.offClick(back); button?.hide(); };
  }, [router]);
  const selectContext = async (channel: "DIRECT" | "REFERRAL") => {
    if (contextBusy.current || readOnly || pending.size > 0) return;
    contextBusy.current = true;
    setContextPending(true);
    setContextError("");
    setContextRetry(null);
    const body = channel === "REFERRAL" && cart?.pendingReferral
      ? { channel, touchId: cart.pendingReferral.touchId } : { channel };
    const send = (confirmReplace: boolean) => fetch("/api/v1/cart/context", { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ ...body, confirmReplace }) });
    const errorCode = async (response: Response): Promise<string | undefined> => {
      const result = await response.json().catch(() => null);
      return result?.error?.code;
    };
    const retryMessage = "Не удалось выбрать источник покупки. Возможен временный сбой связи. Повторите попытку.";
    try {
      let response = await send(false);
      let code = response.ok ? undefined : await errorCode(response);
      if (response.status === 409 && code === "CONTEXT_CONFIRMATION_REQUIRED") {
        if (!window.confirm("Смена источника покупки очистит текущую корзину. Продолжить?")) return;
        response = await send(true);
        code = response.ok ? undefined : await errorCode(response);
      }
      if (!response.ok) {
        if (response.status >= 500) {
          setContextError(retryMessage);
          setContextRetry(channel);
        } else if (response.status === 401 || code === "AUTH_REQUIRED" || code === "SESSION_EXPIRED") {
          setContextError("Сессия истекла. Откройте приложение заново через Telegram.");
        } else if (code === "CSRF_INVALID") {
          setContextError("Не удалось подтвердить безопасность запроса. Откройте приложение заново через Telegram.");
        } else if (code === "REFERRAL_UNAVAILABLE") {
          setContextError("Этот источник покупки больше недоступен. Выберите обычную покупку.");
        } else if (code === "USER_BLOCKED") {
          setContextError(messages.USER_BLOCKED!);
        } else {
          setContextError("Не удалось выбрать источник покупки. Обновите корзину и повторите попытку.");
          setContextRetry(channel);
        }
        return;
      }
      await refresh();
    } catch {
      setContextError(retryMessage);
      setContextRetry(channel);
    } finally {
      contextBusy.current = false;
      setContextPending(false);
    }
  };
  return <main className="app-shell buyer-shell"><div className="buyer-container">
    <BuyerHeader title="Корзина" backHref="/shop" backLabel="Продолжить покупки"
      subtitle="Всё, что вы выбрали, — в одном месте." />
    {error && <p role="alert" className="buyer-notice text-danger">{error}</p>}
    {cart?.purchaseContext?.channel === "REFERRAL" && <section className="buyer-notice" aria-label="Покупка по ссылке партнёра">
      <p>{cart.purchaseContext.available === false ? "Ссылка партнёра больше недоступна. Этот заказ нельзя оформить по ней." : `Вы покупаете по ссылке партнёра${cart.purchaseContext.partnerDisplayName ? ` ${cart.purchaseContext.partnerDisplayName}` : ""}. Цена для вас не меняется.`}</p>
      <button disabled={contextPending || readOnly || pending.size > 0} className="buyer-text-action" onClick={() => void selectContext("DIRECT")}>Покупать без ссылки партнёра</button>
    </section>}
    {cart?.pendingReferral && <section className="buyer-notice" aria-label="Выбор источника покупки">
      <p>Вы открыли ссылку партнёра{cart.pendingReferral.partnerDisplayName ? ` ${cart.pendingReferral.partnerDisplayName}` : ""}. Выберите, к какой покупке отнести этот заказ.</p>
      <div className="buyer-stack-actions"><button disabled={contextPending || readOnly || pending.size > 0} className="app-button app-button-primary" onClick={() => void selectContext("REFERRAL")}>Продолжить по ссылке партнёра</button>
      <button disabled={contextPending || readOnly || pending.size > 0} className="buyer-text-action" onClick={() => void selectContext("DIRECT")}>Обычная покупка</button></div>
    </section>}
    {contextError && <p role="alert" className="buyer-notice text-danger">{contextError}</p>}
    {contextPending && <p role="status" className="buyer-notice">Выбираем источник покупки…</p>}
    {contextRetry && <button disabled={contextPending || readOnly || pending.size > 0} className="buyer-text-action"
      onClick={() => void selectContext(contextRetry)}>Повторить выбор источника</button>}
    <div className="buyer-section-heading"><h2>Ваш выбор{cart?.items.length ? ` · ${cart.items.length}` : ""}</h2>
      <button type="button" className="buyer-text-action" onClick={() => void refresh()}>Обновить корзину</button></div>
    {!cart && !error && <div aria-label="Загрузка корзины" className="space-y-4">{[0, 1, 2].map((i) => <div key={i} className="buyer-skeleton h-32" />)}</div>}
    {cart?.items.length === 0 && <BuyerEmpty title="В корзине пока нет товаров." description="Найдите часы для своего ритма — и возвращайтесь к оформлению.">
      <Link href="/shop" className="app-button app-button-primary">Выбрать товары</Link></BuyerEmpty>}
    {cart && cart.items.length > 0 && <div className="buyer-flow-grid">
      <section><ul className="buyer-cart-list">{cart.items.map((item) => <li key={item.variantId} className="buyer-cart-item">
        <div className="buyer-item-heading"><span className="buyer-item-icon"><ShopIcon name="watch" size={32} /></span><div className="min-w-0 flex-1">
          <h2><Link href={`/shop?product=${encodeURIComponent(item.slug)}`}>{item.title}</Link></h2>
          <p className="text-sm text-muted">Артикул: {item.sku}</p>
          <p className="mt-1 text-sm">{money(item.priceMinor, cart.currency)} за шт. · {money(item.lineTotalMinor, cart.currency)}</p>
        </div></div>
        {item.issues.map((issue) => <p key={issue} className="buyer-notice text-warning">{messages[issue]}</p>)}
        {errors[item.variantId] && <p role="alert" className="buyer-notice text-danger">{errors[item.variantId]}</p>}
        <div className="buyer-item-controls"><div className="buyer-stepper" aria-label={`Количество ${item.sku}`}>
          <button type="button" aria-label={`Уменьшить ${item.sku}`} disabled={contextPending || readOnly || pending.has(item.variantId) || item.quantity <= 1}
            onClick={() => void mutate(item.variantId, item.quantity - 1)}>−</button>
          <span aria-live="polite">{item.quantity}</span>
          <button type="button" aria-label={`Увеличить ${item.sku}`} disabled={contextPending || readOnly || pending.has(item.variantId) || item.quantity >= 99 || item.issues.length > 0}
            onClick={() => void mutate(item.variantId, item.quantity + 1)}>+</button>
        </div><button type="button" disabled={contextPending || readOnly || pending.has(item.variantId)} className="buyer-text-action"
            onClick={() => void mutate(item.variantId)}>Удалить <span className="sr-only">{item.sku}</span></button></div>
        {pending.has(item.variantId) && <p role="status" className="text-sm text-muted">Сохранение…</p>}
      </li>)}</ul>
      <button type="button" disabled={contextPending || readOnly || pending.has("clear")} className="buyer-text-action mt-3"
        onClick={() => void mutate("clear", undefined, true)}>{pending.has("clear") ? "Очистка…" : "Очистить корзину"}</button>
      {errors.clear && <p role="alert" className="buyer-notice text-danger">{errors.clear}</p>}</section>
      <aside className="buyer-summary"><h2>Ваш заказ</h2><dl className="buyer-summary-lines">
        <div><dt>Количество часов</dt><dd>{cart.items.reduce((sum, item) => sum + item.quantity, 0)}</dd></div>
        <div><dt>Доставка</dt><dd>Уточняется магазином</dd></div></dl>
        <p className="text-sm text-muted">Получателя и адрес укажете на следующем шаге.</p>
        <BuyerActionBar inlineOnDesktop><div className="buyer-bar-content">
          <p className="buyer-total">Итого: <strong>{money(cart.totalMinor, cart.currency)}</strong></p>
          {!cart.canCheckout && <p className="text-sm text-warning">Проверьте отмеченные товары перед оформлением заказа.</p>}
          <button type="button" disabled={contextPending || readOnly || !cart.canCheckout || pending.size > 0 || (cart.purchaseContext?.channel === "REFERRAL" && cart.purchaseContext.available === false)}
            onClick={() => router.push("/checkout")} className="app-button app-button-primary w-full disabled:opacity-40">Оформить заказ</button>
        </div></BuyerActionBar>
      </aside>
    </div>}
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
  return <section className="buyer-product-purchase mt-5" aria-label="Добавление товара в корзину">
    <label className="block">Вариант товара<select className="app-input mt-2 min-h-11 w-full px-3 sm:ml-3 sm:mt-0 sm:w-auto" value={selectedId}
      onChange={(event) => { setSelectedId(event.target.value); setAdded(false); }}>
      {variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.sku}</option>)}
    </select></label>
    {selected && <p className="my-3">{money(selected.priceMinor, currency)}</p>}
    {selected && selected.availability !== "IN_STOCK" && <p className="mt-2 text-warning">Этот вариант сейчас нельзя заказать.</p>}
    {quantity >= 99 && <p className="mt-2 text-warning">Можно заказать не больше 99 единиц одного варианта.</p>}
    {added && <p role="status" className="mt-2 text-success">Добавлено в корзину.</p>}
    {(errors[selectedId] || error) && <p role="alert" className="mt-2 text-danger">{errors[selectedId] || error}</p>}
    <BuyerActionBar label="Действия с товаром" inlineOnDesktop>
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
        <button type="button" disabled={!cart || readOnly || !selected || selected.availability !== "IN_STOCK" || quantity >= 99 || pending.has(selectedId)}
          className="app-button app-button-primary min-h-11 min-w-0 max-w-full flex-1 px-4 disabled:opacity-40 sm:flex-none" onClick={() => {
            setAdded(false); void mutate(selectedId, quantity + 1).then((success) => setAdded(Boolean(success)));
          }}>{pending.has(selectedId) ? "Добавление…" : "Добавить в корзину"}</button>
        <Link href="/cart" className="buyer-cart-link"><ShopIcon name="bag" size={20} /><span className="buyer-cart-label">Корзина </span><span>({cart?.items.length ?? 0})</span></Link>
      </div>
    </BuyerActionBar>
  </section>;
}

export function CartIndicator({ csrfToken, className = "inline-flex min-h-11 items-center underline" }: { csrfToken: string; className?: string }) {
  const { cart } = useCart(csrfToken);
  return <Link href="/cart" className={className}>Корзина{cart ? ` (${cart.items.length})` : ""}</Link>;
}
