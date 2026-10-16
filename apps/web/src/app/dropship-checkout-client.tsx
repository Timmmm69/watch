"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { dropshipCheckoutRequestSchema, MAX_ORDER_TOTAL_MINOR, type DropshipCheckoutRequest } from "@watch/contracts";

type Variant = { id: string; sku: string; dropshipPriceMinor: number | null; sellable: number; availability: string };
type Product = { title: string; slug: string; currency: string; variants: Variant[] };
type Document = { id: string; version: string; contentMarkdown: string };
type Fields = { recipientName: string; phone: string; address: string; comment: string };
const labels: Record<keyof Fields, string> = { recipientName: "Имя получателя", phone: "Телефон", address: "Адрес получателя", comment: "Комментарий (необязательно)" };
const money = (value: number, currency: string) => `${(value / 100).toFixed(2)} ${currency}`;
const messages: Record<string, string> = {
  PRICE_CHANGED: "Цена дропу изменилась. Проверьте новый расчёт и подтвердите его перед отправкой.",
  PRICE_BELOW_D: "Цена покупателю R должна быть не ниже цены дропу D.",
  OUT_OF_STOCK: "Недостаточно товара. Уменьшите количество или выберите другой SKU.",
  INVENTORY_UNKNOWN: "Наличие ещё не подтверждено. Оформление временно недоступно.",
  CART_CHANGED: "Товар недоступен. Вернитесь в каталог и выберите другой SKU.",
  TERMS_VERSION_CHANGED: "Условия изменились. Проверьте актуальные документы и подтвердите ознакомление снова.",
  TERMS_REACCEPT_REQUIRED: "Примите актуальные условия дропшиппера в кабинете.",
  PARTNER_REQUIRED: "Для оформления станьте дропшиппером.", PARTNER_BLOCKED: "Дропшиппер заблокирован. Доступен только просмотр истории.",
  USER_BLOCKED: "Доступ заблокирован.", AUTH_REQUIRED: "Откройте приложение заново через Telegram.",
  SESSION_EXPIRED: "Откройте приложение заново через Telegram.", CSRF_INVALID: "Сессия обновилась. Откройте форму заново.",
  ORDER_TOTAL_LIMIT_EXCEEDED: "Сумма заказа не должна превышать 20 000 000.00 BYN.",
  IDEMPOTENCY_CONFLICT: "Ключ отправки уже использован с другими данными. Откройте форму заново.",
  VALIDATION_ERROR: "Проверьте обязательные поля и денежные суммы."
};
class ApiError extends Error {
  constructor(readonly code: string, readonly details?: { items?: { variantId: string; dropshipPriceMinor: number }[] }) {
    super(messages[code] ?? "Не удалось выполнить запрос. Повторите попытку.");
  }
}
// Integer conversion avoids accepting exponents, fractions of a kopeck or floating point rounding.
function minor(value: string): number | null {
  const match = /^(\d{1,8})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const result = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return result <= MAX_ORDER_TOTAL_MINOR ? result : null;
}

export function DropshipCheckoutScreen({ csrfToken, partner, termsReacceptRequired }: {
  csrfToken: string; partner: { id: string; status: string } | null; termsReacceptRequired: boolean;
}) {
  const [product, setProduct] = useState<Product>();
  const [variantId, setVariantId] = useState("");
  const [quantity, setQuantity] = useState("1"), [retail, setRetail] = useState("");
  const [fields, setFields] = useState<Fields>({ recipientName: "", phone: "", address: "", comment: "" });
  const [documents, setDocuments] = useState<{ terms: Document; privacy: Document }>();
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [priceChanged, setPriceChanged] = useState(false), [priceConfirmed, setPriceConfirmed] = useState(false);
  const [error, setError] = useState(""), [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false), [retry, setRetry] = useState(0);
  const [order, setOrder] = useState<{ publicNumber: string; currency: string; totalMinor: number; remunerationTotalMinor: number }>();
  const busy = useRef(false), token = useRef(csrfToken);
  const submission = useRef<{ fingerprint: string; key: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const request = async (url: string, body?: unknown, key?: string) => {
    const send = () => fetch(url, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      ...(body ? { headers: { "content-type": "application/json", "x-csrf-token": token.current, "Idempotency-Key": key! }, body: JSON.stringify(body) } : {}) });
    let response = await send();
    if (response.status === 401) {
      const session = await fetch("/api/v1/auth/session", { credentials: "same-origin", cache: "no-store" });
      if (session.ok) { token.current = (await session.json()).csrfToken; response = await send(); }
    }
    const result = await response.json();
    if (!response.ok) throw new ApiError(result.error?.code, result.error?.details);
    return result;
  };
  const loadDocuments = async () => {
    setDocuments(undefined); setPrivacyAccepted(false);
    const [terms, privacy] = await Promise.all([request("/api/v1/legal/PARTNER_TERMS/current"), request("/api/v1/legal/PRIVACY/current")]);
    setDocuments({ terms, privacy });
  };
  useEffect(() => {
    let active = true;
    const params = new URLSearchParams(window.location.search), slug = params.get("product");
    if (!slug || !partner) return;
    setError("");
    void Promise.all([request(`/api/v1/catalog/products/${encodeURIComponent(slug)}`),
      request("/api/v1/legal/PARTNER_TERMS/current"), request("/api/v1/legal/PRIVACY/current")])
      .then(([next, terms, privacy]) => {
        if (!active) return;
        setProduct(next); setDocuments({ terms, privacy });
        setVariantId(params.get("variant") ?? next.variants[0]?.id ?? "");
      }).catch((cause: Error) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [retry]);
  const variant = product?.variants.find((item) => item.id === variantId);
  const r = minor(retail), q = Number(quantity), d = variant?.dropshipPriceMinor;
  const validQuantity = /^\d+$/.test(quantity) && q >= 1 && q <= 99;
  const total = r !== null && validQuantity ? r * q : null;
  const markup = r !== null && d !== null && d !== undefined && validQuantity ? (r - d) * q : null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy.current || !documents || !variant) return;
    const body = { ...fields, items: [{ variantId, quantity: q, customerUnitPriceMinor: r,
      expectedDropshipPriceMinor: d }], partnerTermsDocumentId: documents.terms.id,
      privacyDocumentId: documents.privacy.id, privacyAcknowledged: privacyAccepted };
    const parsed = dropshipCheckoutRequestSchema.safeParse(body);
    const nextErrors: Record<string, string> = {};
    if (!parsed.success) for (const issue of parsed.error.issues) {
      const field = issue.path[0] === "items" ? String(issue.path[2] ?? "quantity") : String(issue.path[0]);
      nextErrors[field] = field === "phone" ? "Укажите телефон из 8–15 цифр." : field === "recipientName" ? "Укажите имя: 2–100 символов."
        : field === "address" ? "Укажите адрес: 5–500 символов." : field === "quantity" ? "Количество: целое от 1 до 99."
        : field === "comment" ? "Комментарий: не больше 500 символов." : field === "privacyAcknowledged" ? "Подтвердите ознакомление с обработкой данных."
        : "Укажите сумму от 0 до 20 000 000 с точностью до копейки.";
    }
    if (!validQuantity) nextErrors.quantity = "Количество: целое от 1 до 99.";
    if (r !== null && d !== null && d !== undefined && r < d) nextErrors.customerUnitPriceMinor = messages.PRICE_BELOW_D!;
    if (total !== null && total > MAX_ORDER_TOTAL_MINOR) nextErrors.customerUnitPriceMinor = messages.ORDER_TOTAL_LIMIT_EXCEEDED!;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) { form.current?.querySelector<HTMLElement>(`[name="${Object.keys(nextErrors)[0]}"]`)?.focus(); return; }
    if (!parsed.success || (priceChanged && !priceConfirmed)) return;
    const fingerprint = JSON.stringify(parsed.data);
    // Retain only the hashable request identity/key in session storage, never recipient PII.
    const storageKey = `watch:checkout:${partner!.id}`;
    if (!submission.current) {
      try { submission.current = JSON.parse(sessionStorage.getItem(storageKey) ?? "null"); } catch { /* Memory fallback. */ }
    }
    busy.current = true; setPending(true); setError("");
    try {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint))))
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (submission.current?.fingerprint !== digest) submission.current = { fingerprint: digest, key: crypto.randomUUID() };
      try { sessionStorage.setItem(storageKey, JSON.stringify(submission.current)); } catch { /* Memory fallback. */ }
      const result = await request("/api/v1/orders", parsed.data satisfies DropshipCheckoutRequest, submission.current.key);
      setOrder(result);
      try { sessionStorage.removeItem(storageKey); } catch { /* Nothing to clear. */ }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Ответ не получен. Повторите отправку: те же данные используют прежний ключ заказа.");
      if (cause instanceof ApiError && cause.code === "PRICE_CHANGED" && cause.details?.items) {
        const prices = cause.details.items;
        setProduct((old) => old && ({ ...old, variants: old.variants.map((item) => ({ ...item,
          dropshipPriceMinor: prices.find((price) => price.variantId === item.id)?.dropshipPriceMinor ?? item.dropshipPriceMinor })) }));
        setPriceChanged(true); setPriceConfirmed(false);
      }
      if (cause instanceof ApiError && cause.code === "TERMS_VERSION_CHANGED") {
        try { await loadDocuments(); } catch (failure) { setError((failure as Error).message); }
      }
    } finally { busy.current = false; setPending(false); }
  };
  const inputClass = "mt-1 min-h-11 w-full rounded-lg bg-slate-800 px-3";
  return <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100"><div className="mx-auto max-w-2xl space-y-5">
    <nav className="flex gap-5"><Link className="min-h-11 underline" href="/shop">В каталог</Link><Link className="min-h-11 underline" href="/partner/orders">Мои заказы</Link></nav>
    <h1 className="text-2xl font-semibold">Заказ дропшиппера</h1>
    {order ? <section role="status" className="space-y-3"><h2>Заказ {order.publicNumber} оформлен</h2>
      <p>Сумма покупателю: {money(order.totalMinor, order.currency)}</p><p>Предполагаемая наценка: {money(order.remunerationTotalMinor, order.currency)}</p>
      <p>Заказ зарезервирован. Оплата ещё не подтверждена.</p><Link className="inline-flex min-h-11 underline" href={`/partner/orders/${order.publicNumber}`}>Открыть заказ</Link></section>
      : !partner || partner.status !== "ACTIVE" || termsReacceptRequired ? <section><p role="alert">{!partner ? messages.PARTNER_REQUIRED : partner.status !== "ACTIVE" ? messages.PARTNER_BLOCKED : messages.TERMS_REACCEPT_REQUIRED}</p><Link href="/partner/onboarding">Условия дропшиппера</Link></section>
      : <>
        {error && <p role="alert" className="text-rose-300">{error}</p>}
        {!product ? <><p>Выберите SKU в каталоге.{error ? " Не удалось загрузить форму." : ""}</p><button className="min-h-11 underline" onClick={() => setRetry((value) => value + 1)}>Повторить загрузку</button></>
          : <form ref={form} onSubmit={(event) => void submit(event)} noValidate className="space-y-5">
            <fieldset disabled={pending} className="space-y-4 disabled:opacity-60"><legend className="text-xl">{product.title}</legend>
              <label className="block">SKU<select className={inputClass} value={variantId} onChange={(event) => { setVariantId(event.target.value); setPriceConfirmed(false); }}>
                {product.variants.map((item) => <option key={item.id} value={item.id}>{item.sku}</option>)}</select></label>
              <p>Цена дропу D: {d === null || d === undefined ? "не задана" : money(d, product.currency)} · Доступно: {variant?.sellable ?? 0}</p>
              <label className="block">Количество<input name="quantity" className={inputClass} inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.target.value)} aria-invalid={!!errors.quantity} /></label>
              {errors.quantity && <p role="alert">{errors.quantity}</p>}
              <label className="block">Цена покупателю за штуку (R), {product.currency}<input name="customerUnitPriceMinor" className={inputClass} inputMode="decimal" value={retail} onChange={(event) => setRetail(event.target.value)} aria-invalid={!!errors.customerUnitPriceMinor} /></label>
              {errors.customerUnitPriceMinor && <p role="alert">{errors.customerUnitPriceMinor}</p>}
              <section aria-label="Предварительный расчёт" aria-live="polite" className="rounded-xl bg-slate-900 p-4">
                <p>Сумма покупателю: {total === null ? "—" : money(total, product.currency)}</p>
                <p>Сумма владельцу по D: {d == null || !validQuantity ? "—" : money(d * q, product.currency)}</p>
                <p>Предполагаемая наценка: {markup === null ? "—" : money(markup, product.currency)}</p>
                <p className="mt-2 text-sm text-slate-300">Владелец получает всю сумму R. Ваша наценка R−D ещё не доступна к выплате. Доставка согласуется отдельно.</p>
              </section>
              {(Object.keys(labels) as (keyof Fields)[]).map((field) => <div key={field}><label className="block">{labels[field]}<input name={field} type={field === "phone" ? "tel" : "text"} className={inputClass} value={fields[field]} aria-invalid={!!errors[field]}
                maxLength={field === "recipientName" ? 100 : 500} onChange={(event) => setFields({ ...fields, [field]: event.target.value })} /></label>{errors[field] && <p role="alert">{errors[field]}</p>}</div>)}
              <p className="text-sm text-slate-300">Получателю не нужен Telegram. Заказ оформляете вы по условиям дропшиппера.</p>
              {documents && <><details><summary className="min-h-11 cursor-pointer">Условия дропшиппера · {documents.terms.version}</summary><p className="whitespace-pre-wrap">{documents.terms.contentMarkdown}</p></details>
                <details><summary className="min-h-11 cursor-pointer">Обработка данных · {documents.privacy.version}</summary><p className="whitespace-pre-wrap">{documents.privacy.contentMarkdown}</p></details>
                <label className="flex min-h-11 items-center gap-3"><input name="privacyAcknowledged" type="checkbox" checked={privacyAccepted} onChange={(event) => setPrivacyAccepted(event.target.checked)} />Я ознакомился с обработкой передаваемых мной данных получателя.</label></>}
              {errors.privacyAcknowledged && <p role="alert">{errors.privacyAcknowledged}</p>}
              {priceChanged && <label className="flex min-h-11 items-center gap-3 text-amber-300"><input type="checkbox" checked={priceConfirmed} onChange={(event) => setPriceConfirmed(event.target.checked)} />Подтверждаю новый расчёт по актуальной D</label>}
              <button disabled={!documents || d == null || variant?.availability !== "IN_STOCK" || (priceChanged && !priceConfirmed)} className="min-h-11 rounded-lg bg-blue-600 px-5 disabled:opacity-40">{pending ? "Оформляем…" : "Оформить заказ"}</button>
            </fieldset>
          </form>}
      </>}
  </div></main>;
}
