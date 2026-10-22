"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { PartnerEarnings } from "./earnings-client";

type Terms = { id: string; version: string; sha256: string; contentMarkdown: string; effectiveAt: string };
type Partner = { id: string; status: "ACTIVE" | "BLOCKED" };
export type PartnerAuth = { user: { firstName: string }; partner?: Partner | null;
  partnerTermsReacceptRequired?: boolean; csrfToken: string; isAdmin?: boolean; launchTarget?: string; nativeCommerce?: boolean };

export function partnerReacceptUrl() {
  return `/partner/onboarding?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
}

export function PartnerOnboarding({ auth, onAccepted }: { auth: PartnerAuth; onAccepted: (auth: PartnerAuth) => void }) {
  const router = useRouter();
  const [document, setDocument] = useState<Terms | null>(null), [accepted, setAccepted] = useState(false);
  const [error, setError] = useState(""), [pending, setPending] = useState(false);
  const busy = useRef(false), token = useRef(auth.csrfToken);
  const reaccept = !!auth.partner;
  const loadTerms = useCallback(async () => {
    setDocument(null); setAccepted(false);
    try {
      const response = await fetch("/api/v1/legal/PARTNER_TERMS/current", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error();
      setDocument(await response.json() as Terms);
    } catch { setError("Не удалось открыть условия участия. Попробуйте ещё раз."); }
  }, []);
  useEffect(() => { void loadTerms(); }, [loadTerms]);
  useEffect(() => {
    const back = () => router.replace(auth.partner ? "/partner" : "/shop");
    const button = window.Telegram?.WebApp?.BackButton;
    button?.show(); button?.onClick(back);
    return () => { button?.offClick(back); button?.hide(); };
  }, [router, auth.partner]);
  const submit = async () => {
    if (!accepted || !document || busy.current) return;
    busy.current = true; setPending(true); setError("");
    try {
      const send = () => fetch("/api/v1/partner/onboarding", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "x-csrf-token": token.current },
        body: JSON.stringify({ documentId: document.id, documentVersion: document.version, accept: true }) });
      let response = await send();
      if (response.status === 401 || response.status === 403) {
        const body = await response.clone().json().catch(() => ({}));
        if (response.status === 401 || body.error?.code === "CSRF_INVALID") {
          const session = await fetch("/api/v1/auth/session", { credentials: "same-origin", cache: "no-store" });
          if (session.ok) { token.current = (await session.json() as PartnerAuth).csrfToken; response = await send(); }
        }
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        if (body.error?.code === "TERMS_VERSION_CHANGED") {
          await loadTerms(); setError("Условия участия обновились. Прочитайте новую версию и примите её."); return;
        }
        throw new Error(body.error?.code === "USER_BLOCKED" ? "Ваш аккаунт заблокирован. Обратитесь в поддержку." : "Не удалось сохранить согласие. Попробуйте ещё раз.");
      }
      // Re-read server authority, including reacceptance and CSRF, after the committed acceptance.
      const session = await fetch("/api/v1/auth/session", { credentials: "same-origin", cache: "no-store" });
      if (!session.ok) throw new Error("Не удалось обновить данные. Попробуйте принять условия ещё раз.");
      const updated = await session.json() as PartnerAuth;
      if (!updated.partner || updated.partnerTermsReacceptRequired) {
        await loadTerms(); setError("Условия обновились. Прочитайте и примите текущую версию."); return;
      }
      onAccepted(updated);
    } catch (cause) { setError(cause instanceof TypeError ? "Ответ не получен. Попробуйте ещё раз: повторная отправка не создаст новый аккаунт." : cause instanceof Error ? cause.message : "Не удалось сохранить согласие. Попробуйте ещё раз."); }
    finally { busy.current = false; setPending(false); }
  };
  return <section className="my-6 space-y-4 rounded-xl bg-slate-900 p-5" aria-label="Условия партнёрской программы">
    <h1 className="text-2xl font-semibold">{reaccept ? "Принять новые условия" : "Стать партнёром"}</h1>
    <p>Делитесь ссылкой на магазин или товар. Комиссия фиксируется при создании заказа и становится доступной после доставки и периода удержания. Выплаты выполняет оператор.</p>
    {error && <p role="alert" className="text-amber-300">{error}</p>}
    {!document ? <><p role="status">Открываем условия…</p><button className="min-h-11 underline" disabled={pending} onClick={() => { setError(""); void loadTerms(); }}>Повторить загрузку</button></> : <>
      <p>Версия условий: {document.version} · Действует с {new Date(document.effectiveAt).toLocaleDateString("ru-BY")}</p>
      <p className="break-all text-sm text-slate-400">SHA-256: {document.sha256}</p>
      <article aria-label="Условия партнёрской программы" className="whitespace-pre-wrap break-words rounded bg-slate-950 p-4">{document.contentMarkdown}</article>
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={accepted} disabled={pending}
        onChange={(event) => setAccepted(event.target.checked)} />Я прочитал и принимаю условия партнёрской программы</label>
      <button className="min-h-11 rounded bg-blue-600 px-4 disabled:opacity-40" disabled={!accepted || pending} onClick={() => void submit()}>
        {pending ? "Сохраняем согласие…" : reaccept ? "Принять новые условия" : "Стать партнёром"}</button>
    </>}
    <Link className="block min-h-11 underline" href={auth.partner ? "/partner" : "/shop"}>Назад</Link>
  </section>;
}

export function PartnerDashboard({ auth, onAccepted }: { auth: PartnerAuth; onAccepted: (auth: PartnerAuth) => void }) {
  const router = useRouter();
  const [link, setLink] = useState(""), [error, setError] = useState(""), [pending, setPending] = useState(false);
  const [orders, setOrders] = useState<{ publicNumber: string; status: string; totalMinor: number; currency: string }[] | null>(null);
  const [ordersError, setOrdersError] = useState(false), [retry, setRetry] = useState(0);
  const blocked = auth.partner?.status === "BLOCKED";
  useEffect(() => {
    if (!auth.partner) return;
    const controller = new AbortController(); setOrdersError(false);
    void fetch("/api/v1/partner/orders?page=1&limit=3", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ items: NonNullable<typeof orders> }>; })
      .then((result) => { if (!controller.signal.aborted) setOrders(result.items); })
      .catch(() => { if (!controller.signal.aborted) setOrdersError(true); });
    return () => controller.abort();
  }, [auth.partner?.id, retry]);
  const getLink = async () => {
    if (pending || blocked || auth.partnerTermsReacceptRequired) return;
    setPending(true); setError("");
    try {
      const response = await fetch("/api/v1/partner/referral-links", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "x-csrf-token": auth.csrfToken }, body: JSON.stringify({ productId: null }) });
      const body = await response.json();
      if (body.error?.code === "TERMS_REACCEPT_REQUIRED") { router.push(partnerReacceptUrl()); return; }
      if (!response.ok) throw new Error(body.error?.code === "PARTNER_BLOCKED" ? "Партнёрский аккаунт заблокирован. История доступна для просмотра." : "Не удалось получить ссылку. Повторите попытку.");
      setLink(body.url);
    } catch (cause) { setError((cause as Error).message); }
    finally { setPending(false); }
  };
  return <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100"><div className="mx-auto max-w-4xl space-y-5">
    <h1 className="text-2xl font-semibold">Кабинет партнёра</h1>
    {!auth.partner ? <PartnerOnboarding auth={auth} onAccepted={onAccepted} /> : <>
      {blocked && <p role="status" className="rounded bg-amber-950 p-4">Партнёрский аккаунт заблокирован. История доступна, но создавать ссылки и запрашивать выплаты нельзя.</p>}
      {auth.partnerTermsReacceptRequired && <><p role="alert">Чтобы снова создавать ссылки и запрашивать выплаты, примите обновлённые условия участия.</p><PartnerOnboarding auth={auth} onAccepted={onAccepted} /></>}
      <nav aria-label="Кабинет партнёра" className="flex flex-wrap gap-5">
         <Link href="/shop">Каталог товаров</Link><Link href="/partner/orders">Заказы</Link><Link href="/partner/earnings">Доходы</Link><Link href="/partner/payouts">Выплаты</Link>
      </nav>
      <PartnerEarnings compact blocked={blocked} />
      {!auth.nativeCommerce && <section aria-label="Партнёрская ссылка" className="rounded-xl bg-slate-900 p-4"><h2 className="text-lg font-semibold">Ссылка на магазин</h2>
        <button className="mt-3 min-h-11 rounded bg-blue-600 px-4 disabled:opacity-40" disabled={pending || blocked || !!auth.partnerTermsReacceptRequired} onClick={() => void getLink()}>Получить ссылку на магазин</button>
        {link && <><p className="mt-3 break-all">{link}</p><button className="min-h-11 underline" onClick={() => { void navigator.clipboard.writeText(link).catch(() => setError("Не удалось скопировать ссылку. Выделите её и скопируйте вручную.")); }}>Скопировать ссылку</button></>}
        {error && <p role="alert">{error}</p>}
      </section>}
      <section id="orders" className="rounded-xl bg-slate-900 p-4"><h2 className="text-lg font-semibold">Последние заказы</h2>
        {ordersError ? <><p role="alert">Не удалось загрузить заказы.</p><button className="min-h-11 underline" onClick={() => setRetry((n) => n + 1)}>Повторить</button></>
           : orders === null ? <p role="status">Загрузка заказов…</p> : !orders.length ? <p>Заказов пока нет</p> : <ul>{orders.map((order) => <li className="mt-3" key={order.publicNumber}><Link className="inline-flex min-h-11 items-center underline" href={`/partner/orders/${encodeURIComponent(order.publicNumber)}`}>{order.publicNumber}</Link> · {order.status} · {new Intl.NumberFormat("ru-BY", { style: "currency", currency: order.currency }).format(order.totalMinor / 100)}</li>)}</ul>}
      </section>
    </>}
    <Link className="inline-flex min-h-11 items-center underline" href="/shop">Открыть каталог</Link>
  </div></main>;
}
