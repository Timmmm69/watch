"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AdminPartnerDetail, AdminPartnerList } from "../../../../packages/contracts/src/admin-partners";

const partnerLabels: Record<string, string> = { ACTIVE: "Активен", BLOCKED: "Заблокирован" };
const referralLinkLabels: Record<string, string> = { ACTIVE: "Активна", DISABLED: "Отключена" };
const orderLabels: Record<string, string> = {
  PLACED: "Создан", CONFIRMED: "Подтверждён", FULFILLING: "Собирается", SHIPPED: "Отправлен",
  DELIVERED: "Доставлен", COMPLETED: "Завершён", CANCELLED: "Отменён", DELIVERY_FAILED: "Не доставлен"
};
const payoutLabels: Record<string, string> = { REQUESTED: "Ожидает обработки", PAID: "Выплачена", REJECTED: "Отклонена" };

const control = "min-h-11 rounded border border-control bg-surface-muted px-3 py-2";
const money = (n: number, currency: string) => new Intl.NumberFormat("ru-BY", { style: "currency", currency }).format(n/100);
const date = (s: string) => new Date(s).toLocaleString("ru-BY");

export function AdminPartnersScreen({ csrfToken, partnerId }: { csrfToken: string; partnerId?: string }) {
  const router = useRouter(), token = useRef(csrfToken), sequence = useRef(0), busy = useRef(false);
  const [list, setList] = useState<AdminPartnerList | null>(null), [detail, setDetail] = useState<AdminPartnerDetail | null>(null);
  const [query, setQuery] = useState("page=1&limit=20"), [draft, setDraft] = useState({ status: "", search: "" });
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [error, setError] = useState(""), [denied, setDenied] = useState(false);
  const [action, setAction] = useState<{ path: string; title: string } | null>(null), [reason, setReason] = useState("");
  const request = useCallback(async (path: string, payload?: object) => {
    const send = () => fetch(path, { method: payload ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      headers: payload ? { "content-type": "application/json", "x-csrf-token": token.current } : undefined,
      body: payload ? JSON.stringify(payload) : undefined });
    let response = await send();
    if (response.status === 401) {
      const session = await fetch("/api/v1/auth/session", { credentials: "same-origin", cache: "no-store" });
      if (session.ok) { token.current = (await session.json() as { csrfToken: string }).csrfToken; response = await send(); }
    }
    if (response.status === 401 || response.status === 403) {
      setDenied(true); setList(null); setDetail(null); setAction(null);
      throw new Error("Этот раздел доступен только администратору. При ошибке входа откройте приложение через Telegram заново.");
    }
    if (!response.ok) throw new Error(response.status === 404 ? "Не удалось найти партнёра или ссылку. Обновите страницу." : "Не удалось выполнить запрос. Обновите данные и повторите попытку.");
    return response.json();
  }, []);
  const refresh = useCallback(async () => {
    const current = ++sequence.current; setLoading(true); setError(""); setList(null); setDetail(null);
    try {
      const body = await request(partnerId ? `/api/v1/admin/partners/${encodeURIComponent(partnerId)}?${query}` : `/api/v1/admin/partners?${query}`);
      if (current !== sequence.current) return;
      if (partnerId) setDetail(body); else setList(body);
    } catch (cause) { if (current === sequence.current) setError((cause as Error).message); }
    finally { if (current === sequence.current) setLoading(false); }
  }, [partnerId, query, request]);
  useEffect(() => { void refresh(); return () => { ++sequence.current; }; }, [refresh]);
  useEffect(() => {
    const button = window.Telegram?.WebApp?.BackButton;
    const back = () => { if (window.history.length>1) router.back(); else router.replace(partnerId ? "/admin/partners" : "/admin"); };
    button?.show(); button?.onClick(back);
    return () => { button?.offClick(back); button?.hide(); };
  }, [router, partnerId]);
  function filter(event: FormEvent) {
    event.preventDefault(); const params = new URLSearchParams({ page: "1", limit: "20" });
    if (draft.status) params.set("status", draft.status); if (draft.search.trim()) params.set("search", draft.search.trim());
    if (params.toString() === query) void refresh(); else setQuery(params.toString());
  }
  async function mutate(event: FormEvent) {
    event.preventDefault(); if (busy.current || !action || !reason.trim() || denied) return;
    busy.current = true; setPending(true); setError("");
    try { await request(action.path, { reason: reason.trim() }); setAction(null); setReason(""); await refresh(); }
    catch (cause) { setError((cause as Error).message); }
    finally { busy.current = false; setPending(false); }
  }
  function confirm(path: string, title: string) { setReason(""); setAction({ path, title }); }
  const pagination = (page: number, limit: number, total: number) => total>limit && <nav aria-label="Страницы" className="flex items-center gap-4">
    <button className={control} disabled={page<=1 || loading || pending || !!action} onClick={() => { const p=new URLSearchParams(query); p.set("page",String(page-1)); setQuery(p.toString()); }}>Назад</button>
    <span>Страница {page}</span><button className={control} disabled={page*limit>=total || loading || pending || !!action} onClick={() => { const p=new URLSearchParams(query); p.set("page",String(page+1)); setQuery(p.toString()); }}>Далее</button></nav>;
  return <main className="min-h-screen space-y-5 bg-canvas p-5 text-ink sm:p-8">
    <nav aria-label="Администрирование" className="flex flex-wrap gap-4"><Link href="/admin">Обзор</Link><Link href="/admin/partners">Партнёры</Link><Link href="/admin/orders">Заказы</Link><Link href="/admin/payouts">Выплаты</Link></nav>
    <h1 className="text-2xl font-bold">{partnerId ? "Партнёр" : "Партнёры"}</h1>
    {error && <p role="alert">{error}</p>}
    {!denied && <button className={control} disabled={loading || pending || !!action} onClick={() => void refresh()}>Обновить</button>}
    {loading && <p role="status">Загружаем партнёров…</p>}
    {!partnerId && !denied && <form onSubmit={filter} className="flex flex-wrap gap-3">
      <label>Статус<select aria-label="Статус" className={control} value={draft.status} onChange={e => setDraft({ ...draft,status: e.target.value })}><option value="">Все</option><option value="ACTIVE">{partnerLabels.ACTIVE}</option><option value="BLOCKED">{partnerLabels.BLOCKED}</option></select></label>
      <label>Поиск<input className={control} maxLength={128} value={draft.search} onChange={e => setDraft({ ...draft,search: e.target.value })} /></label>
      <button className={control} disabled={loading}>Применить</button></form>}
    {list && <><p>Найдено: {list.total}</p>{list.items.length === 0 && <p>По выбранным условиям партнёров нет.</p>}<ul className="space-y-3">{list.items.map(p => <li key={p.id} className="space-y-2 rounded-xl border border-hairline p-4">
      <Link className="underline" href={`/admin/partners/${p.id}`}>{p.user.firstName} {p.user.lastName} {p.user.username && `@${p.user.username}`}</Link>
      <p>{p.id} · {partnerLabels[p.status] ?? "Статус уточняется"} · {date(p.createdAt)}</p><p>Заказы: {p.attributedOrders} · Завершённые: {p.completedOrders} · Активные ссылки: {p.activeReferralLinks}</p>
      <p>Ожидает: {money(p.pendingAmountMinor,p.currency)} · Доступно: {money(p.availableAmountMinor,p.currency)}</p></li>)}</ul>{pagination(list.page,list.limit,list.total)}</>}
    {detail && <>
      <section className="space-y-2 rounded-xl border border-hairline p-4"><h2 className="text-xl">{detail.user.firstName} {detail.user.lastName}</h2>
        <p>{detail.id} · {partnerLabels[detail.status] ?? "Статус уточняется"}</p><p>Telegram: {detail.user.telegramUserId} {detail.user.username && `@${detail.user.username}`}</p><p>Создан: {date(detail.createdAt)}</p>
        {detail.user.isBlocked && <p>Пользователь заблокирован во всей системе.</p>}{detail.partnerTermsReacceptRequired && <p>Партнёру нужно принять обновлённые условия. Разблокировка не заменяет согласие.</p>}
        {detail.blockReason && <p>Причина блокировки: {detail.blockReason}</p>}{detail.blockedAt && <p>Заблокирован: {date(detail.blockedAt)}</p>}
        <p>Ожидает: {money(detail.pendingAmountMinor,detail.currency)} · Доступно: {money(detail.availableAmountMinor,detail.currency)}</p>
        <p>Заказы: {detail.attributedOrders} · Завершённые: {detail.completedOrders}</p>
        <button className={control} disabled={pending || !!action} onClick={() => confirm(`/api/v1/admin/partners/${detail.id}/${detail.status === "ACTIVE" ? "block" : "unblock"}`,detail.status === "ACTIVE" ? "Заблокировать партнёра" : "Разблокировать партнёра")}>{detail.status === "ACTIVE" ? "Заблокировать" : "Разблокировать"}</button>
      </section>
      <section className="space-y-3"><h2 className="text-xl">Реферальные ссылки</h2><p>Активные: {detail.activeReferralLinks} · Всего: {detail.referralLinks.total}</p>
        {!detail.referralLinks.items.length && <p>Реферальных ссылок пока нет.</p>}<ul className="space-y-3">{detail.referralLinks.items.map(l => <li key={l.id} className="rounded-xl border border-hairline p-3">
          <p>{l.id} · {referralLinkLabels[l.status] ?? "Статус уточняется"} · {l.productId ? `Товар: ${l.productId}` : "Ссылка на магазин"}</p><p>Создана: {date(l.createdAt)}</p>
          {l.disabledAt && <p>Отключена: {date(l.disabledAt)} · {l.disableReason}</p>}
          {l.status === "ACTIVE" && <button className={control} disabled={pending || !!action} onClick={() => confirm(`/api/v1/admin/referral-links/${l.id}/disable`,"Отключить реферальную ссылку")}>Отключить ссылку</button>}</li>)}</ul>
        {pagination(detail.referralLinks.page,detail.referralLinks.limit,detail.referralLinks.total)}</section>
      <section className="space-y-3"><h2 className="text-xl">Последние заказы</h2>{!detail.recentOrders.length && <p>Связанных заказов пока нет.</p>}<ul>{detail.recentOrders.map(o => <li key={o.id}><Link className="underline" href={`/admin/orders/${o.id}`}>{o.publicNumber}</Link> · {orderLabels[o.status] ?? "Статус уточняется"} · {money(o.totalMinor,detail.currency)} · Комиссия: {o.commissionEligible ? "да" : "нет"} · {date(o.createdAt)}</li>)}</ul></section>
      <section className="space-y-3"><h2 className="text-xl">Выплаты</h2><p>Ожидают: {detail.payouts.requested} · Выплачены: {detail.payouts.paid} · Отклонены: {detail.payouts.rejected}</p>
        <Link className="block underline" href={`/admin/payouts?partnerId=${detail.id}`}>История выплат партнёра</Link>
        {detail.payoutConfigurationResolved && detail.availableAmountMinor>0 && detail.availableAmountMinor>=detail.minimumPayoutMinor && detail.payouts.requested===0 && <Link className="block underline" href={`/admin/payouts?partnerId=${detail.id}`}>Создать расчётную выплату</Link>}
        {!detail.payoutConfigurationResolved && <p>Запросы выплат не настроены.</p>}<ul>{detail.payouts.recent.map(p => <li key={p.id}><Link className="underline" href={`/admin/payouts/${p.id}`}>{payoutLabels[p.status] ?? "Статус уточняется"} · {money(p.amountMinor,detail.currency)} · {date(p.requestedAt)}</Link></li>)}</ul></section>
    </>}
    {action && !denied && <form onSubmit={mutate} aria-label="Подтверждение действия" className="space-y-3 rounded-xl border border-warning p-4">
      <h2 className="text-xl">{action.title}</h2><p>Подтвердите действие. Начисленные средства и история сохраняются.</p>
      <label className="block">Причина действия<textarea className={`${control} block w-full`} required maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <button className={control} disabled={pending || !reason.trim()}>Подтвердить действие</button><button type="button" className={control} disabled={pending} onClick={() => setAction(null)}>Отмена</button></form>}
  </main>;
}
