"use client";

import { ShopContact } from "./shop-contact";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { dropshipCheckoutRequestSchema, MAX_ORDER_TOTAL_MINOR, type DropshipCheckoutRequest } from "@watch/contracts";
import { PartnerOnboarding } from "./partner-client";

type Variant = { id: string; sku: string; dropshipPriceMinor: number | null; sellable: number; availability: string };
type Product = { title: string; slug: string; currency: string; variants: Variant[] };
type Document = { id: string; version: string; contentMarkdown: string };
type Fields = { recipientName: string; phone: string; address: string; comment: string };
const labels: Record<keyof Fields, string> = { recipientName: "Имя получателя", phone: "Телефон", address: "Адрес доставки", comment: "Комментарий (необязательно)" };
const money = (value: number, currency: string) => `${(value / 100).toFixed(2)} ${currency}`;
const messages: Record<string, string> = {
  PRICE_CHANGED: "Ваша цена изменилась. Проверьте новый расчёт и подтвердите его перед отправкой.",
  PRICE_BELOW_D: "Укажите цену не ниже вашей цены за 1 шт.",
  OUT_OF_STOCK: "Недостаточно товара. Уменьшите количество или выберите другой вариант часов.",
  INVENTORY_UNKNOWN: "Наличие ещё не подтверждено. Оформление временно недоступно.",
  CART_CHANGED: "Товар недоступен. Вернитесь в каталог и выберите другой вариант часов.",
  TERMS_VERSION_CHANGED: "Условия изменились. Проверьте актуальные документы и подтвердите ознакомление снова.",
  TERMS_REACCEPT_REQUIRED: "Примите актуальные условия партнёра.",
  PARTNER_REQUIRED: "Для оформления заказов для покупателей примите условия сотрудничества.", PARTNER_BLOCKED: "Партнёрский аккаунт заблокирован. Доступен только просмотр истории.",
  USER_BLOCKED: "Доступ заблокирован.", AUTH_REQUIRED: "Откройте приложение заново через Telegram.",
  SESSION_EXPIRED: "Откройте приложение заново через Telegram.", CSRF_INVALID: "Сессия обновилась. Откройте форму заново.",
  ORDER_TOTAL_LIMIT_EXCEEDED: "Сумма заказа не должна превышать 20 000 000.00 BYN.",
  IDEMPOTENCY_CONFLICT: "Не удалось отправить изменённый заказ. Проверьте, не появился ли он в «Моих заказах», затем откройте форму заново.",
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

export function DropshipCheckoutScreen({ csrfToken, partner, termsReacceptRequired, supportContact }: {
  supportContact?: string; csrfToken: string; partner: { id: string; status: string } | null; termsReacceptRequired: boolean;
}) {
  const router = useRouter();
  const [needsTerms, setNeedsTerms] = useState(termsReacceptRequired);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [product, setProduct] = useState<Product>();
  const [loading, setLoading] = useState(true), [hasSelection, setHasSelection] = useState(false);
  const [variantId, setVariantId] = useState("");
  const [quantity, setQuantity] = useState("1"), [retail, setRetail] = useState("");
  const [fields, setFields] = useState<Fields>({ recipientName: "", phone: "", address: "", comment: "" });
  const [documents, setDocuments] = useState<{ terms: Document; privacy: Document }>();
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [previousPrice, setPreviousPrice] = useState<number | null>(null);
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
    const csrfInvalid = response.status === 403 && (await response.clone().json().catch(() => ({}))).error?.code === "CSRF_INVALID";
    if (response.status === 401 || csrfInvalid) {
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
    setHasSelection(!!slug);
    if (!slug || !partner || partner.status !== "ACTIVE" || needsTerms) { setLoading(false); return; }
    setError(""); setLoading(true);
    void Promise.all([request(`/api/v1/catalog/products/${encodeURIComponent(slug)}`),
      request("/api/v1/legal/PARTNER_TERMS/current"), request("/api/v1/legal/PRIVACY/current")])
      .then(([next, terms, privacy]) => {
        if (!active) return;
        setPrivacyAccepted((accepted) => documents?.privacy.id === privacy.id && accepted);
        const before = product?.variants.find((item) => item.id === variantId)?.dropshipPriceMinor;
        const after = next.variants.find((item: Variant) => item.id === variantId)?.dropshipPriceMinor;
        if (before != null && after != null && before !== after) {
          setPreviousPrice(before); setPriceChanged(true); setPriceConfirmed(false);
        }
        setProduct(next); setDocuments({ terms, privacy });
        setVariantId((selected) => selected || params.get("variant") || next.variants.find((item: Variant) => item.availability === "IN_STOCK" && item.dropshipPriceMinor != null)?.id || "");
      }).catch((cause: Error) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry]);
  useEffect(() => {
    const back = () => router.replace("/shop");
    const button = window.Telegram?.WebApp?.BackButton;
    button?.show(); button?.onClick(back);
    return () => { button?.offClick(back); button?.hide(); };
  }, [router]);
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
    if (r !== null && d != null && r < d) nextErrors.customerUnitPriceMinor = `Укажите цену не ниже ${money(d, product!.currency)} за 1 шт.`;
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
      setError(cause instanceof ApiError ? cause.message : "Ответ не получен. Повторите отправку с теми же данными — повторный заказ не создастся.");
      if (cause instanceof ApiError && ["USER_BLOCKED", "PARTNER_BLOCKED", "PARTNER_REQUIRED"].includes(cause.code)) setAccessError(cause.code);
      if (cause instanceof ApiError && cause.code === "TERMS_REACCEPT_REQUIRED") {
        setNeedsTerms(true);
      }
      if (cause instanceof ApiError && cause.code === "PRICE_CHANGED" && cause.details?.items) {
        const prices = cause.details.items;
        setPreviousPrice(d ?? null);
        setProduct((old) => old && ({ ...old, variants: old.variants.map((item) => ({ ...item,
          dropshipPriceMinor: prices.find((price) => price.variantId === item.id)?.dropshipPriceMinor ?? item.dropshipPriceMinor })) }));
        setPriceChanged(true); setPriceConfirmed(false);
      }
      if (cause instanceof ApiError && cause.code === "TERMS_VERSION_CHANGED") {
        try { await loadDocuments(); } catch (failure) { setError((failure as Error).message); }
      }
    } finally { busy.current = false; setPending(false); }
  };
  const inputClass = "app-input mt-1 w-full";
  if (accessError === "USER_BLOCKED") return <main className="app-shell min-h-dvh bg-canvas text-ink"><p role="alert">Доступ к приложению ограничен. Обратитесь в поддержку.</p><ShopContact contact={supportContact} /></main>;
  return <main className="app-shell min-h-dvh bg-canvas text-ink"><div className="mx-auto max-w-2xl space-y-5">
    <nav className="flex gap-5"><Link className="min-h-11 underline" href="/shop">В каталог</Link><Link className="min-h-11 underline" href="/partner/orders">Мои заказы</Link></nav>
    <h1>Новый заказ для покупателя</h1>
    {order ? <section role="status" className="space-y-3"><h2>Заказ №{order.publicNumber} создан</h2>
      <p>Стоимость часов для покупателя: {money(order.totalMinor, order.currency)}</p><p>Ожидаемый заработок: {money(order.remunerationTotalMinor, order.currency)}</p>
      <p>Товар зарезервирован. Оплата пока не подтверждена. Проверяйте статус и данные доставки в заказе.</p><Link className="inline-flex min-h-11 underline" href={`/partner/orders/${order.publicNumber}`}>Открыть заказ</Link><Link className="block min-h-11 underline" href="/shop">Выбрать другие часы</Link><ShopContact contact={supportContact} /></section>
      : !partner || partner.status !== "ACTIVE" || accessError ? <section className="space-y-3"><p role="alert">{!partner || accessError === "PARTNER_REQUIRED" ? "Это форма заказа для партнёров. Для покупки часов выберите модель в каталоге и согласуйте покупку с магазином." : messages.PARTNER_BLOCKED}</p>
        <Link className="app-button" href="/shop">Выбрать часы</Link><ShopContact contact={supportContact} /></section>
      : needsTerms ? <PartnerOnboarding
        auth={{ user: { firstName: "" }, partner: { id: partner.id, status: "ACTIVE" }, csrfToken: token.current, nativeCommerce: true, partnerTermsReacceptRequired: true }}
        onAccepted={(updated) => { token.current = updated.csrfToken; setNeedsTerms(false); setError(""); setRetry((value) => value + 1); }} />
      : <>
        {error && <p role="alert" className="text-danger">{error}</p>}
        {loading ? <p role="status">Загрузка товара и условий…</p> : !product ? <>
          <p>{hasSelection ? "Не удалось загрузить форму заказа." : "Выберите товар в каталоге, затем нажмите «Оформить заказ»."}</p>
          {hasSelection && <button className="min-h-11 underline" onClick={() => setRetry((value) => value + 1)}>Повторить загрузку</button>}</>
          : <form ref={form} onSubmit={(event) => void submit(event)} noValidate className="space-y-5">
            <fieldset disabled={pending} className="space-y-4 disabled:opacity-60"><legend className="text-xl">{product.title}</legend>
              <label className="block">Вариант часов<select className={inputClass} value={variant?.id ?? ""} onChange={(event) => { setVariantId(event.target.value); setErrors((old) => ({ ...old, customerUnitPriceMinor: "" })); setPriceChanged(false); setPriceConfirmed(false); }}>
                <option value="" disabled>Выберите вариант часов</option>
                {product.variants.map((item) => <option key={item.id} value={item.id}>{item.sku}</option>)}</select></label>
              {!variant && <p role="alert">Выберите доступный вариант товара для оформления.</p>}
              <p>Ваша цена за 1 шт.: {d === null || d === undefined ? "не задана" : money(d, product.currency)} · Доступно: {variant?.sellable ?? 0}</p>
              <label className="block">Количество<input name="quantity" className={inputClass} inputMode="numeric" value={quantity} onChange={(event) => { setQuantity(event.target.value); setErrors((old) => ({ ...old, quantity: "", customerUnitPriceMinor: "" })); setPriceConfirmed(false); }} aria-invalid={!!errors.quantity} aria-describedby={errors.quantity ? "quantity-error" : undefined} /></label>
              {errors.quantity && <p id="quantity-error" role="alert">{errors.quantity}</p>}
              <label className="block">Цена для покупателя за 1 шт., {product.currency}<input name="customerUnitPriceMinor" className={inputClass} inputMode="decimal" value={retail} onChange={(event) => { setRetail(event.target.value); setErrors((old) => ({ ...old, customerUnitPriceMinor: "" })); setPriceConfirmed(false); }} aria-invalid={!!errors.customerUnitPriceMinor} aria-describedby={errors.customerUnitPriceMinor ? "retail-hint retail-error" : "retail-hint"} /></label>
              {d != null && <p id="retail-hint" className="text-sm text-muted">Не ниже вашей цены: {money(d, product.currency)} за 1 шт.</p>}
              {errors.customerUnitPriceMinor && <p id="retail-error" role="alert">{errors.customerUnitPriceMinor}</p>}
              <section aria-label="Предварительный расчёт" aria-live="polite" className="app-panel">
                <p>Стоимость часов для покупателя: {total === null ? "—" : money(total, product.currency)}</p>
                <p>Стоимость по вашей цене: {d == null || !validQuantity ? "—" : money(d * q, product.currency)}</p>
                <p>Ожидаемый заработок: {markup === null ? "—" : money(markup, product.currency)}</p>
                <p className="mt-2 text-sm text-ink-secondary">Оплату за заказ получает магазин. Ваш ожидаемый заработок — {markup === null ? "—" : money(markup, product.currency)}. Он станет доступен к выплате после выполнения условий по доставке, оплате и возвратам. Доставка согласуется отдельно.</p>
              </section>
              {(Object.keys(labels) as (keyof Fields)[]).map((field) => <div key={field}><label htmlFor={`dropship-${field}`} className="block">{labels[field]}</label>
                {field === "address" || field === "comment" ? <textarea id={`dropship-${field}`} name={field} className={`${inputClass} min-h-24`} value={fields[field]} maxLength={500}
                  aria-invalid={!!errors[field]} aria-describedby={errors[field] ? `${field}-error` : undefined}
                  onChange={(event) => setFields({ ...fields, [field]: event.target.value })} />
                  : <input id={`dropship-${field}`} name={field} type={field === "phone" ? "tel" : "text"} className={inputClass} value={fields[field]} aria-invalid={!!errors[field]}
                    aria-describedby={errors[field] ? `${field}-error` : undefined} maxLength={field === "recipientName" ? 100 : 500}
                    autoComplete={field === "phone" ? "tel" : "name"} onChange={(event) => setFields({ ...fields, [field]: event.target.value })} />}
              {errors[field] && <p id={`${field}-error`} role="alert">{errors[field]}</p>}</div>)}
              <p className="text-sm text-ink-secondary">Получателю не нужен Telegram. Заказ оформляете вы по условиям партнёра.</p>
              {documents && <><details><summary className="min-h-11 cursor-pointer">Условия партнёра · {documents.terms.version}</summary><p className="whitespace-pre-wrap">{documents.terms.contentMarkdown}</p></details>
                <details><summary className="min-h-11 cursor-pointer">Обработка данных · {documents.privacy.version}</summary><p className="whitespace-pre-wrap">{documents.privacy.contentMarkdown}</p></details>
                <label className="flex min-h-11 items-center gap-3"><input name="privacyAcknowledged" type="checkbox" checked={privacyAccepted} aria-invalid={!!errors.privacyAcknowledged} aria-describedby={errors.privacyAcknowledged ? "privacy-error" : undefined} onChange={(event) => setPrivacyAccepted(event.target.checked)} />Я ознакомился с обработкой передаваемых мной данных получателя.</label></>}
              {errors.privacyAcknowledged && <p id="privacy-error" role="alert">{errors.privacyAcknowledged}</p>}
              {!documents && <div><p role="alert">Документы не загружены. Оформление станет доступно после загрузки.</p>
                <button type="button" className="min-h-11 underline" onClick={() => { setError(""); void loadDocuments().catch((cause: Error) => setError(cause.message)); }}>Повторить загрузку документов</button></div>}
              {priceChanged && <p role="status">Ваша цена изменилась: {previousPrice == null ? "—" : money(previousPrice, product.currency)} → {d == null ? "—" : money(d, product.currency)}. Ожидаемый заработок теперь {markup === null ? "—" : money(markup, product.currency)}.</p>}
              {priceChanged && <label className="flex min-h-11 items-center gap-3 text-warning"><input type="checkbox" checked={priceConfirmed} onChange={(event) => setPriceConfirmed(event.target.checked)} />Согласен с новым расчётом</label>}
              <button disabled={!documents || d == null || variant?.availability !== "IN_STOCK" || (priceChanged && !priceConfirmed)} className="app-button app-button-primary min-h-11 px-5 disabled:opacity-40">{pending ? "Оформляем…" : "Оформить заказ"}</button>
              {variant && (d == null || variant.availability !== "IN_STOCK") && <p role="status">{d == null ? "Для этого варианта пока не задана цена. Выберите другой вариант." : "Этот вариант сейчас недоступен. Выберите другой вариант или вернитесь в каталог."}</p>}
            </fieldset>
          </form>}
      </>}
  </div></main>;
}
