"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Cart } from "./cart-client";

type Document = { id: string; version: string; contentMarkdown: string };
type Documents = { SALES_TERMS: Document; PRIVACY: Document };
type Fields = { recipientName: string; phone: string; address: string; comment: string };
type Order = { publicNumber: string; totalMinor: number; currency: string; status: string };
const labels: Record<keyof Fields, string> = {
  recipientName: "Имя получателя", phone: "Телефон", address: "Адрес и детали доставки", comment: "Комментарий (необязательно)"
};
const messages: Record<string, string> = {
  PRICE_CHANGED: "Цена изменилась. Проверьте новый итог и подтвердите его перед отправкой.",
  CART_CHANGED: "Корзина изменилась. Проверьте товары перед отправкой.",
  CART_EMPTY: "Корзина пуста.", OUT_OF_STOCK: "Недостаточно товара в наличии. Измените корзину.",
  INVENTORY_STALE: "Данные о наличии устарели. Оформление временно недоступно.",
  INVENTORY_UNKNOWN: "Наличие пока неизвестно. Оформление временно недоступно.",
  TERMS_VERSION_CHANGED: "Документы изменились. Прочитайте новую версию и отметьте соответствующее поле снова.",
  USER_BLOCKED: "Доступ заблокирован. Оформление заказа недоступно.",
  AUTH_REQUIRED: "Откройте приложение заново через Telegram.", SESSION_EXPIRED: "Откройте приложение заново через Telegram.",
  VALIDATION_ERROR: "Проверьте введённые данные.", IDEMPOTENCY_CONFLICT: "Данные отправки изменились. Проверьте форму и повторите попытку.",
  ORDER_TOTAL_LIMIT_EXCEEDED: "Сумма заказа превышает допустимый предел. Измените корзину.",
  CART_LINE_LIMIT_EXCEEDED: "В корзине может быть не больше 100 разных товаров."
};
const money = (minor: number, currency: string) => new Intl.NumberFormat("ru-BY", { style: "currency", currency }).format(minor / 100);
class ApiError extends Error {
  constructor(readonly code: string, readonly details: { affectedVariantIds?: string[] } = {}) {
    super(messages[code] ?? "Не удалось выполнить запрос. Повторите попытку.");
  }
}

export function CheckoutScreen({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const [cart, setCart] = useState<Cart | null>(null);
  const [documents, setDocuments] = useState<Documents | null>(null);
  const currentDocuments = useRef<Documents | null>(null);
  const legalSequence = useRef(0);
  const [legalReady, setLegalReady] = useState(false);
  const [accepted, setAccepted] = useState({ SALES_TERMS: false, PRIVACY: false });
  const [fields, setFields] = useState<Fields>({ recipientName: "", phone: "", address: "", comment: "" });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof Fields, string>>>({});
  const [error, setError] = useState("");
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [priceConfirmation, setPriceConfirmation] = useState(false);
  const [priceConfirmed, setPriceConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);
  const token = useRef(csrfToken);
  const busy = useRef(false);
  const completed = useRef(false);
  const submission = useRef<{ fingerprint: string; key: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const recovery = useRef<Promise<boolean> | null>(null);
  const request = useCallback(async (url: string, body?: unknown, key?: string) => {
    const send = () => fetch(url, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      headers: body ? { "content-type": "application/json", "x-csrf-token": token.current, "Idempotency-Key": key! } : undefined,
      body: body ? JSON.stringify(body) : undefined });
    let response = await send();
    if (response.status === 401) {
      recovery.current ??= fetch("/api/v1/auth/session", { credentials: "same-origin", cache: "no-store" })
        .then(async (result) => { if (!result.ok) return false; token.current = (await result.json()).csrfToken; return true; })
        .finally(() => { recovery.current = null; });
      if (await recovery.current) response = await send();
    }
    const result = await response.json();
    if (!response.ok) {
      const code = response.status === 401 ? "AUTH_REQUIRED" : result.error?.code;
      if (response.status === 401 || code === "USER_BLOCKED") setReadOnly(true);
      throw new ApiError(code, result.error?.details);
    }
    return result;
  }, []);

  const loadDocuments = useCallback(async () => {
    const sequence = ++legalSequence.current;
    setLegalReady(false);
    const [sales, privacy] = await Promise.all([request("/api/v1/legal/SALES_TERMS/current"), request("/api/v1/legal/PRIVACY/current")]);
    if (sequence !== legalSequence.current) return;
    const next: Documents = { SALES_TERMS: sales, PRIVACY: privacy };
    const previous = currentDocuments.current;
    setAccepted((value) => ({ SALES_TERMS: previous?.SALES_TERMS.id === sales.id && value.SALES_TERMS,
      PRIVACY: previous?.PRIVACY.id === privacy.id && value.PRIVACY }));
    currentDocuments.current = next;
    setDocuments(next); setLegalReady(true);
  }, [request]);
  const loadCart = useCallback(async () => {
    const next: Cart = await request("/api/v1/cart");
    setCart(next);
    if (!next.items.length) router.replace("/cart");
    return next;
  }, [request, router]);
  const refresh = async () => {
    if (busy.current) return;
    busy.current = true; setLegalReady(false);
    setError(""); setLineErrors({});
    try { await loadCart(); await loadDocuments(); }
    catch (cause) { setError((cause as Error).message); }
    finally { busy.current = false; }
  };
  useEffect(() => {
    void loadCart().then(loadDocuments).catch((cause: Error) => setError(cause.message));
    const focus = () => {
      if (!busy.current && !completed.current) void loadDocuments().catch((cause: Error) => setError(cause.message));
    };
    // Do not refresh Cart on focus: a lost successful response must remain retryable after Cart clear.
    window.addEventListener("focus", focus);
    const back = () => { if (window.history.length > 1) router.back(); else router.replace("/cart"); };
    const button = window.Telegram?.WebApp?.BackButton;
    button?.show(); button?.onClick(back);
    return () => { window.removeEventListener("focus", focus); button?.offClick(back); button?.hide(); };
  }, [loadCart, loadDocuments, router]);

  const validate = (name: keyof Fields) => {
    const value = fields[name].trim();
    const invalid = name === "recipientName" ? value.length < 2 || value.length > 100
      : name === "phone" ? !/^\+?[\d\s().-]+$/.test(value) || !/^\d{8,15}$/.test(value.replace(/\D/g, ""))
      : name === "address" ? value.length < 5 || value.length > 500 : value.length > 500;
    return invalid ? name === "phone" ? "Укажите телефон из 8–15 цифр." : name === "recipientName"
      ? "Имя должно содержать 2–100 символов." : name === "address" ? "Укажите 5–500 символов." : "Не больше 500 символов." : "";
  };
  const submit = async () => {
    if (busy.current || !cart || !documents || !legalReady || readOnly) return;
    const errors = Object.fromEntries((Object.keys(fields) as (keyof Fields)[]).map((name) => [name, validate(name)]));
    setFieldErrors(errors);
    if (Object.values(errors).some(Boolean)) {
      const name = Object.keys(errors).find((key) => errors[key]);
      form.current?.querySelector<HTMLElement>(`[name="${name}"]`)?.focus(); return;
    }
    if (!cart.canCheckout || !accepted.SALES_TERMS || !accepted.PRIVACY || (priceConfirmation && !priceConfirmed)) return;
    const body = { items: cart.items.map((item) => ({ variantId: item.variantId.toLowerCase(), quantity: item.quantity,
      expectedUnitPriceMinor: item.priceMinor })).sort((a, b) => a.variantId.localeCompare(b.variantId)),
      recipientName: fields.recipientName.trim(), phone: fields.phone.replace(/\D/g, ""), address: fields.address.trim(), comment: fields.comment.trim(),
      salesTermsDocumentId: documents.SALES_TERMS.id.toLowerCase(), privacyDocumentId: documents.PRIVACY.id.toLowerCase(),
      salesTermsAccepted: true, privacyAcknowledged: true };
    const fingerprint = JSON.stringify(body);
    if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, key: crypto.randomUUID() };
    busy.current = true; setPending(true); setError("");
    try {
      const result: Order = await request("/api/v1/orders", body, submission.current.key);
      completed.current = true; setOrder(result);
    } catch (cause) {
      const failure = cause as ApiError;
      setError(failure instanceof ApiError ? failure.message : "Ответ не получен. Повторите отправку: для тех же данных используется тот же ключ заказа.");
      try {
        if (failure.code === "TERMS_VERSION_CHANGED") await loadDocuments();
        if (["PRICE_CHANGED", "CART_CHANGED", "CART_EMPTY", "OUT_OF_STOCK", "INVENTORY_STALE", "INVENTORY_UNKNOWN"].includes(failure.code)) {
          if (failure.code === "PRICE_CHANGED") { setPriceConfirmation(true); setPriceConfirmed(false); }
          setLineErrors(Object.fromEntries((failure.details?.affectedVariantIds ?? cart.items.map((item) => item.variantId))
            .map((id) => [id, failure.message])));
          await loadCart();
        }
      } catch (refreshError) {
        // Old commercial data must not be submitted after a failed conflict refresh.
        if (failure.code !== "TERMS_VERSION_CHANGED") setCart(null);
        setError(`${failure.message} ${(refreshError as Error).message}`);
      }
    } finally { busy.current = false; setPending(false); }
  };

  return <main className="min-h-screen bg-slate-950 px-5 py-8 pb-12 text-slate-100"><div className="mx-auto max-w-2xl">
    <Link href="/cart" className="inline-flex min-h-11 items-center underline">← Корзина</Link>
    <h1 className="my-5 text-2xl font-semibold">{order ? "Заказ оформлен" : "Оформление заказа"}</h1>
    {order ? <section aria-live="polite"><p className="text-xl">Заказ {order.publicNumber}</p><p>Статус: {order.status}</p>
      <p>Итого: {money(order.totalMinor, order.currency)}</p><p className="my-4">Оператор подтвердит заказ.</p>
      <Link href="/shop" className="inline-flex min-h-11 items-center underline">Продолжить покупки</Link></section> : <>
      {error && <p role="alert" className="my-4 text-amber-300">{error}</p>}
      <button type="button" disabled={pending} onClick={() => void refresh()} className="min-h-11 underline disabled:opacity-40">Обновить оформление</button>
      {!cart && <div aria-label="Загрузка заказа" className="my-5 h-36 animate-pulse rounded-xl bg-slate-900" />}
      {cart && <section aria-label="Состав заказа" className="my-5 rounded-xl bg-slate-900 p-4"><ul>{cart.items.map((item) => <li key={item.variantId} className="mb-3">
        <p>{item.title} · {item.sku} · {item.quantity} шт. × {money(item.priceMinor, cart.currency)}</p>
        <p>{money(item.lineTotalMinor, cart.currency)}</p>
        {item.issues.map((issue) => <p key={issue} className="text-amber-300">{issue === "ITEM_UNAVAILABLE" ? "Товар больше недоступен." : messages[issue]}</p>)}
        {lineErrors[item.variantId] && <p className="text-amber-300">{lineErrors[item.variantId]}</p>}
      </li>)}</ul><p className="text-lg">Итого: {money(cart.totalMinor, cart.currency)}</p>
        {!cart.canCheckout && <p className="text-amber-300">Устраните проблемы товаров в корзине перед оформлением.</p>}
        {priceConfirmation && <label className="mt-3 flex min-h-11 items-center gap-3"><input type="checkbox" checked={priceConfirmed}
          onChange={(event) => setPriceConfirmed(event.target.checked)} />Подтверждаю новую цену и итог заказа</label>}
      </section>}
      <form ref={form} noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }} className="space-y-5">
        {(Object.keys(labels) as (keyof Fields)[]).map((name) => <div key={name}>
          <label htmlFor={name} className="mb-2 block">{labels[name]}</label>
          {name === "address" || name === "comment" ? <textarea id={name} name={name} value={fields[name]} disabled={pending || readOnly}
            aria-invalid={Boolean(fieldErrors[name])} aria-describedby={`${name}-error`} className="min-h-24 w-full rounded-lg bg-slate-800 p-3"
            onChange={(event) => setFields({ ...fields, [name]: event.target.value })} onBlur={() => setFieldErrors({ ...fieldErrors, [name]: validate(name) })}
            onFocus={(event) => event.currentTarget.scrollIntoView({ block: "center" })} />
            : <input id={name} name={name} type={name === "phone" ? "tel" : "text"} autoComplete={name === "phone" ? "tel" : "name"}
              value={fields[name]} disabled={pending || readOnly} aria-invalid={Boolean(fieldErrors[name])} aria-describedby={`${name}-error`}
              className="min-h-11 w-full rounded-lg bg-slate-800 p-3" onChange={(event) => setFields({ ...fields, [name]: event.target.value })}
              onBlur={() => setFieldErrors({ ...fieldErrors, [name]: validate(name) })} onFocus={(event) => event.currentTarget.scrollIntoView({ block: "center" })} />}
          {fieldErrors[name] && <p id={`${name}-error`} role="alert" className="mt-1 text-amber-300">{fieldErrors[name]}</p>}
        </div>)}
        {!documents && <div aria-label="Загрузка документов" className="h-24 animate-pulse rounded-lg bg-slate-900" />}
        {documents && (["SALES_TERMS", "PRIVACY"] as const).map((type) => <section key={type}>
          <details className="rounded-lg bg-slate-900 p-4"><summary className="cursor-pointer">{type === "SALES_TERMS" ? "Условия продажи" : "Политика конфиденциальности"} · {documents[type].version}</summary>
            <pre className="mt-3 whitespace-pre-wrap font-sans text-sm">{documents[type].contentMarkdown}</pre></details>
          <label className="flex min-h-11 items-center gap-3 py-3"><input type="checkbox" checked={accepted[type]} disabled={!legalReady || pending || readOnly}
            onChange={(event) => setAccepted({ ...accepted, [type]: event.target.checked })} />
            {type === "SALES_TERMS" ? "Принимаю текущие условия продажи" : "Ознакомлен(а) с текущей политикой конфиденциальности"}</label>
        </section>)}
        <div className="sticky bottom-0 border-t border-slate-700 bg-slate-950 py-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button type="submit" disabled={pending || readOnly || !cart?.canCheckout || !legalReady || !accepted.SALES_TERMS || !accepted.PRIVACY || (priceConfirmation && !priceConfirmed)}
            className="min-h-11 w-full rounded-lg bg-blue-600 px-4 disabled:opacity-40">{pending ? "Отправка…" : "Подтвердить заказ"}</button>
          {pending && <span role="status" className="animate-pulse">Создание заказа…</span>}
        </div>
      </form>
    </>}
  </div></main>;
}
