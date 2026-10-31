"use client";

import Link from "next/link";
import { BuyerHeader } from "./buyer-ui";
import { ShopIcon } from "./shop-icon";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextualCart } from "./cart-client";
import { orderStatuses } from "./order-status";

type Document = { id: string; version: string; contentMarkdown: string };
type Documents = { SALES_TERMS: Document; PRIVACY: Document };
type Fields = { recipientName: string; phone: string; address: string; comment: string };
type Order = { publicNumber: string; totalMinor: number; currency: string; status: string };
const labels: Record<keyof Fields, string> = {
  recipientName: "Имя получателя", phone: "Телефон", address: "Адрес и детали доставки", comment: "Комментарий (необязательно)"
};
const messages: Record<string, string> = {
  PRICE_CHANGED: "Цена изменилась. Проверьте сумму заказа и подтвердите новую цену.",
  CART_CHANGED: "Состав корзины изменился. Проверьте товары перед оформлением.",
  CART_EMPTY: "Корзина пуста.", OUT_OF_STOCK: "Недостаточно товара в наличии. Измените корзину.",
  INVENTORY_STALE: "Наличие товара не подтверждено. Попробуйте оформить заказ позже.",
  INVENTORY_UNKNOWN: "Наличие товара не подтверждено. Попробуйте оформить заказ позже.",
  TERMS_VERSION_CHANGED: "Условия обновились. Прочитайте новые версии документов и подтвердите ознакомление.",
  USER_BLOCKED: "Доступ заблокирован. Оформление заказа недоступно.",
  AUTH_REQUIRED: "Откройте приложение заново через Telegram.", SESSION_EXPIRED: "Откройте приложение заново через Telegram.",
  VALIDATION_ERROR: "Проверьте поля, отмеченные ошибкой.", IDEMPOTENCY_CONFLICT: "Данные заказа изменились. Проверьте форму перед повторной отправкой.",
  ORDER_TOTAL_LIMIT_EXCEEDED: "Сумма заказа превышает допустимый предел. Измените корзину.",
  CART_LINE_LIMIT_EXCEEDED: "В корзине может быть не больше 100 разных товаров."
};
const money = (minor: number, currency: string) => new Intl.NumberFormat("ru-BY", { style: "currency", currency }).format(minor / 100);
class ApiError extends Error {
  constructor(readonly code: string, readonly details: { affectedVariantIds?: string[]; reason?: string } = {}) {
    super(messages[code] ?? "Не удалось выполнить запрос. Повторите попытку.");
  }
}

export function CheckoutScreen({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const [cart, setCart] = useState<ContextualCart | null>(null);
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
    const next: ContextualCart = await request("/api/v1/cart");
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
      ? "Укажите имя от 2 до 100 символов." : name === "address" ? "Укажите адрес от 5 до 500 символов." : "Комментарий не должен превышать 500 символов." : "";
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
      const result: Order = await request("/api/v1/checkout", body, submission.current.key);
      completed.current = true; setOrder(result);
    } catch (cause) {
      const failure = cause as ApiError;
      setError(failure instanceof ApiError ? failure.message : "Ответ не получен. Повторите отправку: для тех же данных используется тот же ключ заказа.");
      try {
        if (failure.code === "CART_CHANGED" && failure.details?.reason === "REFERRAL_UNAVAILABLE") {
          await loadCart();
          setError("Ссылка партнёра больше недоступна. Вернитесь в корзину и выберите обычную покупку.");
          return;
        }
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

  const renderField = (name: keyof Fields) => <div key={name} className="buyer-field">
    <label htmlFor={name}>{labels[name]}</label>
    {name === "address" || name === "comment" ? <textarea id={name} name={name} rows={3} maxLength={500}
      autoComplete={name === "address" ? "street-address" : "off"} value={fields[name]} disabled={pending || readOnly}
      aria-invalid={Boolean(fieldErrors[name])} aria-describedby={fieldErrors[name] ? `${name}-error` : undefined} className="app-input w-full"
      onChange={(event) => setFields({ ...fields, [name]: event.target.value })} onBlur={() => setFieldErrors({ ...fieldErrors, [name]: validate(name) })}
      onFocus={(event) => event.currentTarget.scrollIntoView({ block: "center" })} />
      : <input id={name} name={name} type={name === "phone" ? "tel" : "text"} inputMode={name === "phone" ? "tel" : "text"}
        autoComplete={name === "phone" ? "tel" : "name"} maxLength={name === "phone" ? 40 : 100}
        placeholder={name === "phone" ? "С кодом страны" : "Как к вам обращаться"}
        value={fields[name]} disabled={pending || readOnly} aria-invalid={Boolean(fieldErrors[name])}
        aria-describedby={fieldErrors[name] ? `${name}-error` : undefined} className="app-input w-full"
        onChange={(event) => setFields({ ...fields, [name]: event.target.value })}
        onBlur={() => setFieldErrors({ ...fieldErrors, [name]: validate(name) })} onFocus={(event) => event.currentTarget.scrollIntoView({ block: "center" })} />}
    {fieldErrors[name] && <p id={`${name}-error`} role="alert" className="text-sm text-danger">{fieldErrors[name]}</p>}
  </div>;

  return <main className="app-shell buyer-shell"><div className="buyer-container buyer-narrow">
    <BuyerHeader title={order ? "Заказ создан" : "Оформление заказа"} backHref={order ? "/shop" : "/cart"} backLabel={order ? "В каталог" : "Корзина"}
      subtitle={order ? undefined : "Ещё несколько деталей — и часы станут ближе."} />
    {order ? <section className="buyer-success" aria-live="polite">
      <span className="buyer-success-icon"><ShopIcon name="check" size={44} /></span><h2>Заказ {order.publicNumber}</h2>
      <p>Статус: {orderStatuses[order.status] ?? order.status}</p><p className="buyer-success-total">Итого: {money(order.totalMinor, order.currency)}</p>
      <div className="buyer-notice"><h3>Что дальше</h3><p>Заказ создан. Ожидайте подтверждения оператора.</p></div>
      <div className="buyer-stack-actions"><Link href={`/orders/${encodeURIComponent(order.publicNumber)}`} className="app-button app-button-primary">Посмотреть заказ</Link>
      <Link href="/shop" className="app-button">Продолжить покупки</Link></div>
    </section> : <>
      {error && <p role="alert" className="buyer-notice text-danger">{error}</p>}
      <div className="buyer-section-heading"><h2>Состав заказа</h2><button type="button" disabled={pending} onClick={() => void refresh()} className="buyer-text-action">Обновить данные заказа</button></div>
      {!cart && <div aria-label="Загрузка заказа" className="buyer-skeleton h-36" />}
      {cart?.purchaseContext?.channel === "REFERRAL" && <p className="buyer-notice">{cart.purchaseContext.available === false ? <>Ссылка партнёра больше недоступна. Вернитесь в корзину и выберите обычную покупку.</> : <>Покупка по ссылке партнёра{cart.purchaseContext.partnerDisplayName ? ` ${cart.purchaseContext.partnerDisplayName}` : ""}. Розничная цена для вас не меняется.</>}</p>}
      {cart?.pendingReferral && <p className="buyer-notice">Сейчас выбрана обычная покупка. Открытая ссылка партнёра не применяется к этому заказу.</p>}
      {cart && <section aria-label="Состав заказа" className="buyer-checkout-summary"><ul>{cart.items.map((item) => <li key={item.variantId}>
        <div className="buyer-item-heading"><span className="buyer-item-icon"><ShopIcon name="watch" size={28} /></span><div className="min-w-0 flex-1">
          <h3>{item.title}</h3><p className="text-sm text-muted">{item.sku} · {item.quantity} шт. × {money(item.priceMinor, cart.currency)}</p></div></div>
        <p className="mt-2 text-right font-bold">{money(item.lineTotalMinor, cart.currency)}</p>
        {item.issues.map((issue) => <p key={issue} className="text-warning">{issue === "ITEM_UNAVAILABLE" ? "Товар больше недоступен." : messages[issue]}</p>)}
        {lineErrors[item.variantId] && <p className="text-danger">{lineErrors[item.variantId]}</p>}
      </li>)}</ul>
        {!cart.canCheckout && <p className="buyer-notice text-warning">Проверьте отмеченные товары в корзине.</p>}
        {priceConfirmation && <label className="buyer-consent"><input type="checkbox" checked={priceConfirmed}
          onChange={(event) => setPriceConfirmed(event.target.checked)} />Я проверил и принимаю новую сумму заказа</label>}
      </section>}
      <form ref={form} noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }} className="buyer-checkout-form">
        <section className="buyer-form-section" aria-labelledby="recipient-title"><h2 id="recipient-title"><span>1</span>Получатель</h2>
          <div className="buyer-fields">{renderField("recipientName")}{renderField("phone")}</div></section>
        <section className="buyer-form-section" aria-labelledby="delivery-title"><h2 id="delivery-title"><span>2</span>Доставка</h2>
          <p className="buyer-subtitle">Укажите город и полный адрес. Детали доставки подтвердит магазин.</p>
          <div className="buyer-fields">{renderField("address")}{renderField("comment")}</div></section>
        <section className="buyer-form-section" aria-labelledby="terms-title"><h2 id="terms-title"><span>3</span>Условия покупки</h2>
        {!documents && <div aria-label="Загрузка документов" className="buyer-skeleton h-24" />}
        {documents && (["SALES_TERMS", "PRIVACY"] as const).map((type) => <div key={type} className="buyer-legal-item">
          <details><summary>{type === "SALES_TERMS" ? "Условия продажи" : "Политика конфиденциальности"} · {documents[type].version}</summary>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm">{documents[type].contentMarkdown}</pre></details>
          <label className="buyer-consent"><input type="checkbox" checked={accepted[type]} disabled={!legalReady || pending || readOnly}
            onChange={(event) => setAccepted({ ...accepted, [type]: event.target.checked })} />
            <span>{type === "SALES_TERMS" ? "Принимаю текущие условия продажи" : "Ознакомлен(а) с текущей политикой конфиденциальности"}</span></label>
        </div>)}</section>
        <div className="buyer-submit">
          {cart && <p className="buyer-total">Итого: <strong>{money(cart.totalMinor, cart.currency)}</strong></p>}
          <button type="submit" disabled={pending || readOnly || !cart?.canCheckout || !legalReady || !accepted.SALES_TERMS || !accepted.PRIVACY || (priceConfirmation && !priceConfirmed) || (cart?.purchaseContext?.channel === "REFERRAL" && cart.purchaseContext.available === false)}
            className="app-button app-button-primary w-full disabled:opacity-40">{pending ? "Отправка…" : "Создать заказ"}</button>
          {pending && <p role="status" className="mt-2 text-sm">Создаём заказ…</p>}
          <p className="mt-3 text-center text-sm text-muted">После оформления ожидайте подтверждения оператора.</p>
        </div>
      </form>
    </>}
  </div></main>;
}
