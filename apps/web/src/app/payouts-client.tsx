"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { partnerReacceptUrl } from "./partner-client";

type PayoutStatus = "REQUESTED" | "PAID" | "REJECTED";
type Allocation = { id: string; commissionId: string; amountMinor: number };
type Payout = { id: string; partnerId: string; amountMinor: number; currency: string; status: PayoutStatus;
  requestedByUserId: string; requestedAt: string; allocations: Allocation[]; processedByAdminUserId?: string | null;
  processedAt?: string | null; externalReference?: string | null; note?: string | null };
type PayoutPage = { items: Payout[]; total: number; page: number; limit: number };
type Earnings = { currency: string; availableAmountMinor: number; minimumPayoutMinor?: number; payoutConfigurationResolved?: boolean;
  debtAmountMinor?: number; reversalAmountMinor?: number; payoutBlocked?: boolean };
const labels: Record<PayoutStatus, string> = { REQUESTED: "Ожидает выплаты", PAID: "Выплачена", REJECTED: "Отклонена" };
const money = (amount: number, currency: string) => new Intl.NumberFormat("ru-BY", { style: "currency", currency }).format(amount / 100);
const date = (value: string) => new Date(value).toLocaleString("ru-BY");
const newKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

function errorText(code?: string) {
  if (code === "AUTH_REQUIRED" || code === "SESSION_EXPIRED") return "Срок входа истёк. Откройте приложение заново через Telegram.";
  if (code === "PAYOUT_FACTS_CHANGED") return "Изменились оплата или возвраты. Выплата заблокирована; проверьте деньги, долг и распределения. При необходимости отклоните заявку и создайте новую на актуальную сумму.";
  if (code === "IDEMPOTENCY_CONFLICT") return "Идентификатор операции или перевода уже использован. Проверьте историю.";
  return code === "PARTNER_BLOCKED" ? "Партнёр заблокирован: самостоятельная заявка недоступна."
    : code === "TERMS_REACCEPT_REQUIRED" ? "Требуется принять новые условия партнёрской программы."
      : code === "PAYOUT_CONFIGURATION_MISSING" ? "Выплата сейчас не настроена."
        : code === "PAYOUT_NOT_AVAILABLE" ? "Пока нет суммы для выплаты. Проверьте состояние заработка по заказам."
          : code === "PAYOUT_BELOW_MINIMUM" ? "Доступная сумма меньше минимальной выплаты."
            : code === "PAYOUT_ALREADY_PENDING" ? "Уже есть активная заявка на выплату."
              : code === "PAYOUT_ALREADY_FINALIZED" ? "Заявка уже обработана. Обновите данные."
                : "Не удалось выполнить действие. Повторите попытку.";
}

export function PartnerPayoutsScreen({ csrfToken, blocked, termsReacceptRequired }: { csrfToken: string; blocked: boolean; termsReacceptRequired: boolean }) {
  const router = useRouter();
  const token = useRef(csrfToken), key = useRef<string | null>(null), sequence = useRef(0);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [result, setResult] = useState<PayoutPage | null>(null);
  const [page, setPage] = useState(1), [loading, setLoading] = useState(true), [financeReady, setFinanceReady] = useState(false), [hasActive, setHasActive] = useState(false), [error, setError] = useState("");
  const [pending, setPending] = useState(false), [confirm, setConfirm] = useState(false), [retry, setRetry] = useState(0);
  const [accessBlocked, setAccessBlocked] = useState(false);
  const [activeRequest, setActiveRequest] = useState<Payout | null>(null);
  const request = useCallback(async (url: string, init?: RequestInit) => {
    const send = () => fetch(url, { credentials: "same-origin", cache: "no-store", ...init,
      headers: { ...(init?.headers ?? {}), ...(init?.method === "POST" ? { "x-csrf-token": token.current } : {}) } });
    let response = await send();
    const csrfInvalid = response.status === 403 && (await response.clone().json().catch(() => ({}))).error?.code === "CSRF_INVALID";
    if (response.status === 401 || csrfInvalid) { const recovery = await fetch("/api/v1/auth/session", { credentials: "same-origin", cache: "no-store" });
      if (recovery.ok) { token.current = (await recovery.json() as { csrfToken: string }).csrfToken; response = await send(); } }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(errorText(body.error?.code)), { code: body.error?.code, status: response.status });
    return body;
  }, []);
  const refresh = useCallback(async () => {
    const current = ++sequence.current; setLoading(true); setFinanceReady(false);
    try {
      const [balance, payouts, active] = await Promise.all([request("/api/v1/partner/earnings?page=1&limit=1"), request(`/api/v1/partner/payouts?page=${page}&limit=20`), request("/api/v1/partner/payouts?status=REQUESTED&page=1&limit=1")]);
      if (current !== sequence.current) return; setEarnings(balance as Earnings); setResult(payouts as PayoutPage); setHasActive((active as PayoutPage).total > 0); setActiveRequest((active as PayoutPage).items[0] ?? null); setFinanceReady(true); setError("");
    } catch (cause) { if (current === sequence.current) setError((cause as Error).message); }
    finally { if (current === sequence.current) setLoading(false); }
  }, [page, request]);
  useEffect(() => { void refresh(); return () => { ++sequence.current; }; }, [refresh, retry]);
  useEffect(() => { const back = () => { if (window.history.length > 1) router.back(); else router.replace("/shop"); };
    const button = window.Telegram?.WebApp?.BackButton; button?.show(); button?.onClick(back); return () => { button?.offClick(back); button?.hide(); }; }, [router]);
  const minimum = earnings?.minimumPayoutMinor;
  const configured = earnings?.payoutConfigurationResolved === true && minimum != null;
  const disabledReason = !financeReady ? (error ? "Не удалось проверить условия выплаты. Обновите данные." : "Проверяем условия выплаты…") : blocked || accessBlocked ? "Новые заявки недоступны: доступ ограничен. Обратитесь в поддержку." : termsReacceptRequired ? "Требуется принять новые условия партнёрской программы." : !configured ? "Выплата сейчас не настроена." : hasActive ? `Заявка${activeRequest ? ` на ${money(activeRequest.amountMinor, activeRequest.currency)}` : ""} принята и ожидает обработки. Новую можно отправить после обработки текущей.`
    : !earnings ? "Проверяем условия выплаты…" : earnings.payoutBlocked ? "Выплата заблокирована: проверьте оплату и открытые возвраты заказов." : earnings.availableAmountMinor <= 0 ? "Пока нет суммы для выплаты. Проверьте состояние заработка по заказам." : minimum != null && earnings.availableAmountMinor < minimum ? `Минимальная выплата — ${money(minimum, earnings.currency)}.` : null;
  const submit = async () => {
    if (disabledReason || pending) return; setPending(true); setError("");
    key.current ??= newKey();
    try { await request("/api/v1/partner/payouts", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key.current }, body: "{}" });
      key.current = null; setConfirm(false); await refresh();
    } catch (cause) { setError((cause as Error).message); setConfirm(false); const code = (cause as { code?: string }).code;
      if (code === "TERMS_REACCEPT_REQUIRED") router.push(partnerReacceptUrl());
      if (code === "PARTNER_BLOCKED" || code === "USER_BLOCKED") setAccessBlocked(true);
    }
    finally { setPending(false); }
  };
  return <main className="app-shell min-h-dvh bg-canvas text-ink"><div className="mx-auto max-w-3xl space-y-5">
    <Link className="inline-flex min-h-11 items-center underline" href="/partner">← Партнёрский кабинет</Link><h1>Выплаты</h1>
    {termsReacceptRequired && <Link className="inline-flex min-h-11 items-center underline" href="/partner/onboarding?returnTo=%2Fpartner%2Fpayouts">Принять новые условия</Link>}
    {error && <p role="alert" className="text-danger">{error}</p>}<button className="min-h-11 underline" disabled={pending} onClick={() => setRetry((n) => n + 1)}>Обновить</button>
    {loading ? <div aria-label="Загрузка выплат" className="h-36 animate-pulse rounded-xl bg-surface" /> : earnings && <section className="app-panel">
      {(earnings.debtAmountMinor ?? 0) > 0 && <p className="text-warning">Долг после корректировок: {money(earnings.debtAmountMinor!, earnings.currency)}.</p>}
      {(earnings.reversalAmountMinor ?? 0) > 0 && <p>Корректировки вознаграждений: {money(earnings.reversalAmountMinor!, earnings.currency)}.</p>}
      <h2 className="text-lg font-bold">Доступно для выплаты</h2><p className="mt-2 text-2xl">{money(earnings.payoutBlocked ? 0 : Math.max(0,earnings.availableAmountMinor), earnings.currency)}</p>
      <p className="mt-2 text-ink-secondary">Минимальная сумма: {minimum == null ? "не настроена" : money(minimum, earnings.currency)}. Заявка будет создана на весь доступный баланс.</p>
      {disabledReason ? <p className="mt-3 text-warning">{disabledReason}</p> : <button className="app-button app-button-primary mt-4 min-h-11 px-4 disabled:opacity-50" disabled={pending} onClick={() => setConfirm(true)}>Запросить выплату</button>}
      <p className="mt-3 text-sm text-muted">Выплату переводит сотрудник магазина вне приложения. Платёжные реквизиты здесь не собираются.</p>
    </section>}
    {confirm && <section role="region" aria-label="Подтверждение заявки на выплату" className="app-panel border-warning"><h2 className="font-bold">Подтвердить заявку?</h2>
      <p className="mt-2">Будет запрошена выплата всего доступного баланса: {earnings && money(earnings.availableAmountMinor, earnings.currency)}.</p><button className="app-button app-button-primary mt-3 min-h-11 px-4" disabled={pending} onClick={() => void submit()}>Да, запросить выплату</button><button className="ml-3 min-h-11 px-4 underline" disabled={pending} onClick={() => setConfirm(false)}>Вернуться</button></section>}
    <section><h2 className="text-lg font-bold">История заявок</h2>{result && !result.items.length ? <p className="mt-3 text-muted">Заявок на выплату пока нет.</p> : <ul className="mt-3 space-y-3">{result?.items.map((item) => <li key={item.id} className="app-panel"><div className="flex flex-wrap justify-between gap-2"><strong>{money(item.amountMinor, item.currency)}</strong><span>{labels[item.status]}</span></div><p className="mt-2 text-sm text-muted">Запрошена: {date(item.requestedAt)}</p><details><summary className="min-h-11 cursor-pointer">Из каких начислений состоит выплата</summary><p>Начислений: {item.allocations.length}</p></details></li>)}</ul>}
      {result && result.total > result.limit && <nav aria-label="Страницы выплат" className="mt-4 flex gap-4"><button className="min-h-11" disabled={page === 1} onClick={() => setPage((n) => n - 1)}>Назад</button><span>Страница {result.page}</span><button className="min-h-11" disabled={page * result.limit >= result.total} onClick={() => setPage((n) => n + 1)}>Далее</button></nav>}</section>
  </div></main>;
}

export function AdminPayoutsScreen({ csrfToken, payoutId, partnerId }: { csrfToken: string; payoutId?: string; partnerId?: string }) {
  const router = useRouter(); const token = useRef(csrfToken), sequence = useRef(0), busy = useRef(false), settlementKeys = useRef(new Map<string, string>());
  const [result, setResult] = useState<PayoutPage | null>(null), [detail, setDetail] = useState<Payout | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [pending, setPending] = useState("");
  const [query, setQuery] = useState(() => new URLSearchParams({ page: "1", limit: "20", ...(partnerId ? { partnerId } : {}) }).toString()), [draft, setDraft] = useState({ status: "", partnerId: partnerId ?? "" });
  const [confirm, setConfirm] = useState<PayoutStatus | "">(""), [note, setNote] = useState(""), [reference, setReference] = useState(""), [settlementPartnerId, setSettlementPartnerId] = useState(partnerId ?? ""), [settlementConfirm, setSettlementConfirm] = useState(false);
  const request = useCallback(async (url: string, payload?: object, headers?: Record<string, string>) => {
    const send = () => fetch(url, { method: payload ? "POST" : "GET", credentials: "same-origin", cache: "no-store", headers: payload ? { "content-type": "application/json", "x-csrf-token": token.current, ...headers } : undefined, body: payload ? JSON.stringify(payload) : undefined });
    let response = await send(); if (response.status === 401) { const recovery = await fetch("/api/v1/auth/session", { credentials: "same-origin", cache: "no-store" }); if (recovery.ok) { token.current = (await recovery.json() as { csrfToken: string }).csrfToken; response = await send(); } }
    const body = await response.json().catch(() => ({})); if (!response.ok) throw Object.assign(new Error(response.status === 401 || response.status === 403 ? "Управлять выплатами может только администратор." : errorText(body.error?.code)), { code: body.error?.code }); return body;
  }, []);
  const refresh = useCallback(async () => { const current = ++sequence.current; setLoading(true); try { const body = await request(payoutId ? `/api/v1/admin/payouts/${encodeURIComponent(payoutId)}` : `/api/v1/admin/payouts?${query}`); if (current !== sequence.current) return; if (payoutId) setDetail(body as Payout); else setResult(body as PayoutPage); setError(""); } catch (cause) { if (current === sequence.current) setError((cause as Error).message); } finally { if (current === sequence.current) setLoading(false); } }, [payoutId, query, request]);
  useEffect(() => { void refresh(); return () => { ++sequence.current; }; }, [refresh]);
  useEffect(() => { const back = () => { if (window.history.length > 1) router.back(); else router.replace(payoutId ? "/admin/payouts" : "/shop"); }; const button = window.Telegram?.WebApp?.BackButton; button?.show(); button?.onClick(back); return () => { button?.offClick(back); button?.hide(); }; }, [payoutId, router]);
  const filter = (event: FormEvent) => { event.preventDefault(); const values = new URLSearchParams({ page: "1", limit: "20" }); if (draft.status) values.set("status", draft.status); if (draft.partnerId.trim()) values.set("partnerId", draft.partnerId.trim()); setQuery(values.toString()); };
  const createSettlement = async () => { if (busy.current || !settlementConfirm) return; const partnerKey = settlementPartnerId.trim().toLowerCase(); busy.current = true; setPending("settlement"); const retryKey = settlementKeys.current.get(partnerKey) ?? newKey(); settlementKeys.current.set(partnerKey, retryKey); try { await request(`/api/v1/admin/partners/${encodeURIComponent(partnerKey)}/payouts`, {}, { "idempotency-key": retryKey }); settlementKeys.current.delete(partnerKey); setSettlementConfirm(false); setSettlementPartnerId(""); setError(""); await refresh(); } catch (cause) { setError((cause as Error).message); } finally { busy.current = false; setPending(""); } };
  const transition = async () => { if (!payoutId || !confirm || busy.current) return; if (confirm === "PAID" && !reference.trim()) { setError("Укажите несекретный внешний идентификатор перевода."); return; } if (confirm === "REJECTED" && !note.trim()) { setError("Укажите причину отклонения выплаты."); return; } busy.current = true; setPending(confirm); try { const updated = await request(`/api/v1/admin/payouts/${encodeURIComponent(payoutId)}/transition`, { target: confirm, ...(note.trim() ? { note: note.trim() } : {}), ...(confirm === "PAID" ? { externalReference: reference.trim() } : {}) }); setDetail(updated as Payout); setConfirm(""); setError(""); await refresh(); } catch (cause) { setError((cause as Error).message); } finally { busy.current = false; setPending(""); } };
  const pageNumber = result?.page ?? 1;
  return <main className="app-shell min-h-dvh bg-canvas px-5 py-8 text-ink"><div className="mx-auto max-w-4xl space-y-5"><Link className="inline-flex min-h-11 items-center underline" href={payoutId ? "/admin/payouts" : "/shop"}>← {payoutId ? "Все выплаты" : "Каталог"}</Link><h1 className="text-2xl font-bold">{payoutId ? "Выплата" : "Управление выплатами"}</h1><nav className="flex gap-5" aria-label="Администрирование"><Link href="/admin">Обзор</Link><Link href="/admin/partners">Партнёры</Link><Link href="/admin/analytics">Аналитика</Link></nav>{error && <p role="alert" className="text-danger">{error}</p>}<button className="min-h-11 underline" disabled={!!pending} onClick={() => void refresh()}>Обновить</button>
    {!payoutId && <><form onSubmit={filter} className="grid gap-3 sm:grid-cols-2"><label>Статус<select className="block min-h-11 w-full bg-surface-muted" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}><option value="">Все статусы</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>ID партнёра<input className="block min-h-11 w-full bg-surface-muted" value={draft.partnerId} onChange={(event) => setDraft({ ...draft, partnerId: event.target.value })} /></label><button className="app-button app-button-primary min-h-11 px-4">Применить фильтры</button></form><section className="rounded-xl bg-surface-muted p-4"><h2 className="text-lg font-bold">Расчётная выплата партнёру</h2><p className="mt-2 text-sm text-muted">Создаёт аудируемую заявку на весь доступный баланс. Разрешено и для заблокированного партнёра.</p><label className="mt-3 block">ID партнёра<input className="mt-1 block min-h-11 w-full bg-surface" disabled={settlementConfirm || !!pending} pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" required value={settlementPartnerId} onChange={(event) => setSettlementPartnerId(event.target.value)} /></label><button className="app-button app-button-primary mt-3 min-h-11 px-4" disabled={!!pending || settlementConfirm || !settlementPartnerId.trim()} onClick={() => setSettlementConfirm(true)}>Создать расчётную выплату</button>{settlementConfirm && <section role="region" aria-label="Подтверждение расчётной выплаты" className="mt-3 rounded-xl border border-warning p-3"><p>Будет создана заявка на весь доступный баланс партнёра. Сумму определит сервер.</p><button className="app-button app-button-primary mt-3 min-h-11 px-4" disabled={!!pending} onClick={() => void createSettlement()}>Да, создать заявку</button><button className="ml-3 min-h-11 px-4 underline" disabled={!!pending} onClick={() => setSettlementConfirm(false)}>Вернуться</button></section>}</section></>}
    {loading && <div aria-label="Загрузка выплат" className="h-24 animate-pulse rounded-xl bg-surface-muted" />}
    {!payoutId && result && <>{!result.items.length ? <p>По выбранным условиям заявок нет.</p> : <ul className="space-y-3">{result.items.map((item) => <li key={item.id} className="rounded-xl bg-surface-muted p-4"><Link className="inline-flex min-h-11 items-center underline" href={`/admin/payouts/${item.id}`}>{money(item.amountMinor, item.currency)}</Link><p>{labels[item.status]} · партнёр {item.partnerId}</p><p className="text-sm text-muted">Запрошена: {date(item.requestedAt)}</p></li>)}</ul>}<nav aria-label="Страницы выплат" className="flex gap-4"><button className="min-h-11" disabled={pageNumber <= 1 || loading} onClick={() => { const next = new URLSearchParams(query); next.set("page", String(pageNumber - 1)); setQuery(next.toString()); }}>Назад</button><span>Страница {pageNumber}</span><button className="min-h-11" disabled={pageNumber * (result.limit ?? 20) >= result.total || loading} onClick={() => { const next = new URLSearchParams(query); next.set("page", String(pageNumber + 1)); setQuery(next.toString()); }}>Далее</button></nav></>}
    {detail && <section className="space-y-4"><div className="rounded-xl bg-surface-muted p-4"><h2 className="text-xl">{money(detail.amountMinor, detail.currency)} · {labels[detail.status]}</h2><p className="mt-2">Партнёр: {detail.partnerId}</p><p>Запрошена: {date(detail.requestedAt)}</p><p>Заявку создал: {detail.requestedByUserId}</p>{detail.processedAt && <p>Обработана: {date(detail.processedAt)}</p>}{detail.processedByAdminUserId && <p>Обработал администратор: {detail.processedByAdminUserId}</p>}{detail.externalReference && <p>Внешний идентификатор: {detail.externalReference}</p>}{detail.note && <p>Комментарий: {detail.note}</p>}</div><section><h2 className="text-lg font-bold">Комиссии в выплате</h2>{detail.allocations.length ? <ul className="mt-2 space-y-2">{detail.allocations.map((allocation) => <li key={allocation.id} className="rounded-xl bg-surface-muted p-3">Комиссия {allocation.commissionId} · {money(allocation.amountMinor, detail.currency)}</li>)}</ul> : <p>Распределений нет.</p>}</section>
      {detail.status === "REQUESTED" && <section className="flex flex-wrap gap-3"><button className="min-h-11 rounded-xl bg-surface-muted text-success px-4" disabled={!!pending} onClick={() => { setConfirm("PAID"); setNote(""); setReference(""); }}>Подтвердить выплату</button><button className="min-h-11 rounded-xl bg-danger-soft text-danger px-4" disabled={!!pending} onClick={() => { setConfirm("REJECTED"); setNote(""); setReference(""); }}>Отклонить выплату</button></section>}
      {confirm && <section role="region" aria-label="Подтверждение обработки выплаты" className="rounded-xl border border-warning bg-surface-muted p-4"><h2 className="font-bold">{confirm === "PAID" ? "Подтвердить выполненный перевод" : "Отклонить выплату"}</h2><p className="mt-2">{confirm === "PAID" ? "Отмечайте выплату только после фактического завершения внешнего перевода. Не указывайте банковские или карточные данные." : "Отклонение разблокирует сумму согласно финансовым правилам."}</p>{confirm === "PAID" && <label className="mt-3 block">Внешний идентификатор перевода<input className="mt-1 block min-h-11 w-full bg-surface" required maxLength={200} value={reference} onChange={(event) => setReference(event.target.value)} /></label>}<label className="mt-3 block">Комментарий {confirm === "REJECTED" ? "(причина отклонения)" : "(необязательно)"}<textarea className="mt-1 block w-full bg-surface" required={confirm === "REJECTED"} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} /></label><button className="app-button app-button-primary mt-3 min-h-11 px-4" disabled={!!pending || (confirm === "PAID" && !reference.trim()) || (confirm === "REJECTED" && !note.trim())} onClick={() => void transition()}>{confirm === "PAID" ? "Да, отметить выплаченной" : "Да, отклонить выплату"}</button><button className="ml-3 min-h-11 px-4 underline" disabled={!!pending} onClick={() => setConfirm("")}>Вернуться</button></section>}</section>}
  </div></main>;
}
