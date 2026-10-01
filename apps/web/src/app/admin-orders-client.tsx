"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

const labels: Record<string, string> = { PLACED: "Создан", CONFIRMED: "Подтверждён", FULFILLING: "Собирается", SHIPPED: "Отправлен",
  DELIVERED: "Доставлен", COMPLETED: "Завершён", CANCELLED: "Отменён", DELIVERY_FAILED: "Не доставлен" };
const actions: Record<string, string> = { CONFIRMED: "Подтвердить заказ", FULFILLING: "Начать сборку", SHIPPED: "Подтвердить отправку",
  DELIVERED: "Подтвердить доставку покупателю", CANCELLED: "Отменить заказ", DELIVERY_FAILED: "Зафиксировать недоставку" };
const reservationLabels: Record<string, string> = { ACTIVE: "Активен", RELEASED: "Освобождён", CONSUMED: "Использован" };
const sourceLabels: Record<string, string> = { OK: "В порядке", UNINITIALIZED: "Не загружен", MISSING: "Товар отсутствует в источнике", INVALID: "Некорректные данные" };
type Order = { id: string; publicNumber: string; status: string; totalMinor: number; currency: string; overdue: boolean;
  partnerIdSnapshot: string | null; attributionTouchId: string | null; commissionEligibleSnapshot: boolean; allowedTransitions: string[];
  completionEligibleAt: string | null; timeline: { status: string; at: string }[];
  fulfillment?: { recipientName: string | null; phone: string | null; address: string | null; comment: string | null; redactedAt: string | null } | null;
  items?: { id: string; title: string; sku: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number;
    attributes: Record<string, unknown>; partnerCommissionUnitMinor: number; supplierSettlementUnitMinor: number | null }[];
  reservations?: { id: string; status: string; quantity: number; reconciliationMethod: string | null; reconciliationReference: string | null;
    sourceStatus: string | null; sourceVersion: string | null; lastSuccessfulSyncRunId: string | null; lastSuccessfulSyncAt: string | null;
    allowedManualTargets: ("CONSUMED" | "RELEASED")[]; reconciliationSourceVersion: string | null;
    reconciliationInventorySyncRunId: string | null; reconciledByAdminUserId: string | null; reconciledAt: string | null }[] };
type Page = { items: Order[]; total: number; page: number; limit: number };
const money = (value: number, currency: string) => new Intl.NumberFormat("ru-BY", { style: "currency", currency }).format(value / 100);
const date = (value: string) => new Date(value).toLocaleString("ru-BY");

export function AdminOrdersScreen({ csrfToken, orderId }: { csrfToken: string; orderId?: string }) {
  const router = useRouter();
  const token = useRef(csrfToken);
  const sequence = useRef(0);
  const busy = useRef(false);
  const [result, setResult] = useState<Page | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [pending, setPending] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reconcile, setReconcile] = useState<{ id: string; target: string; snapshot: string } | null>(null);
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [attested, setAttested] = useState(false);
  const [draft, setDraft] = useState({ status: "", number: "", partnerId: "", dateFrom: "", dateTo: "", overdue: false, reconciliationPending: false });
  const [query, setQuery] = useState("page=1&limit=20");
  const request = useCallback(async (url: string, payload?: object) => {
    const send = () => fetch(url, { method: payload ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      headers: payload ? { "content-type": "application/json", "x-csrf-token": token.current } : undefined,
      body: payload ? JSON.stringify(payload) : undefined });
    let response = await send();
    if (response.status === 401) {
      const recovery = await fetch("/api/v1/auth/session", { credentials: "same-origin", cache: "no-store" });
      if (recovery.ok) { token.current = (await recovery.json()).csrfToken; response = await send(); }
    }
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        setBlocked(true); setOrder(null); setResult(null);
        throw new Error(response.status === 401 ? "Откройте приложение заново через Telegram." : "Доступ запрещён. Изменение заказов недоступно.");
      }
      throw Object.assign(new Error(body.error?.code === "INVENTORY_SNAPSHOT_CHANGED"
        ? "Снимок остатков изменился. Проверьте обновлённые данные и подтвердите результат заново."
        : body.error?.code === "INVALID_ORDER_TRANSITION" ? "Статус уже изменился. Обновите заказ и выберите доступное действие."
        : body.error?.code === "NOT_FOUND" ? "Заказ не найден." : "Не удалось загрузить или изменить заказ. Повторите попытку."), { code: body.error?.code });
    }
    return body;
  }, []);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    setReconcile(null); setAttested(false);
    setLoading(true);
    try {
      const body = await request(orderId ? `/api/v1/admin/orders/${encodeURIComponent(orderId)}` : `/api/v1/admin/orders?${query}`);
      if (current !== sequence.current) return;
      if (orderId) setOrder(body); else setResult(body);
      setError("");
    } catch (cause) { if (current === sequence.current) setError((cause as Error).message); }
    finally { if (current === sequence.current) setLoading(false); }
  }, [orderId, query, request]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) void refresh(); });
    return () => { active = false; ++sequence.current; };
  }, [refresh]);
  useEffect(() => {
    const back = () => { if (window.history.length > 1) router.back(); else router.replace(orderId ? "/admin/orders" : "/shop"); };
    const button = window.Telegram?.WebApp?.BackButton;
    button?.show(); button?.onClick(back);
    return () => { button?.offClick(back); button?.hide(); };
  }, [orderId, router]);
  const filter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new URLSearchParams({ page: "1", limit: "20" });
    if (draft.dateFrom && draft.dateTo && draft.dateFrom > draft.dateTo) { setError("Начало периода должно быть раньше конца."); return; }
    for (const [key, value] of Object.entries(draft)) {
      if (!value) continue;
      values.set(key, key === "dateFrom" || key === "dateTo" ? new Date(String(value)).toISOString() : String(value));
    }
    setQuery(values.toString());
  };
  const transition = async (target: string) => {
    if (!orderId || busy.current || blocked) return;
    busy.current = true; setPending(target); ++sequence.current;
    try {
      const updated = await request(`/api/v1/admin/orders/${encodeURIComponent(orderId)}/transition`, { toStatus: target });
      // Retain detail snapshots until the following authoritative detail read.
      setOrder((previous) => previous ? { ...previous, ...updated } : updated);
      setConfirm(""); setError("");
      await refresh();
    } catch (cause) { setError((cause as Error).message); setConfirm(""); }
    finally { busy.current = false; setPending(""); }
  };
  const reconcileReservation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!reconcile || !attested || !reason.trim() || busy.current || loading || blocked) return;
    busy.current = true; setPending(reconcile.id); ++sequence.current;
    try {
      await request(`/api/v1/admin/inventory/reservations/${encodeURIComponent(reconcile.id)}/reconcile`, {
        target: reconcile.target, reason: reason.trim(), ...(evidence.trim() ? { evidenceReference: evidence.trim() } : {}),
        expectedInventorySyncRunId: reconcile.snapshot, confirmSnapshotReflectsOutcome: true
      });
      setOrder(null); setReconcile(null); setAttested(false);
      await refresh();
    } catch (cause) {
      const failure = cause as Error & { code?: string };
      if (failure.code === "INVENTORY_SNAPSHOT_CHANGED" || failure.code === "INVALID_ORDER_TRANSITION") {
        // A failed refresh must leave no old snapshot available for another decision.
        setOrder(null); setReconcile(null); setAttested(false);
        await refresh();
      }
      setError(failure.message);
    } finally { busy.current = false; setPending(""); }
  };
  const turnPage = (page: number) => { const next = new URLSearchParams(query); next.set("page", String(page)); setQuery(next.toString()); };
  return <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100"><div className="mx-auto max-w-4xl space-y-5">
    <Link className="inline-flex min-h-11 items-center underline" href={orderId ? "/admin/orders" : "/shop"}>← {orderId ? "Все заказы" : "Каталог"}</Link>
    <h1 className="text-2xl font-semibold">{orderId ? "Заказ" : "Заказы администратора"}</h1>
    {error && <p role="alert" className="text-rose-300">{error}</p>}
    <button className="min-h-11 underline" disabled={!!pending || blocked} onClick={() => void refresh()}>Обновить</button>
    {!orderId && !blocked && <form onSubmit={filter} className="grid gap-3 sm:grid-cols-2">
      <label>Статус<select className="block min-h-11 w-full bg-slate-900" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
        <option value="">Все статусы</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Номер заказа<input className="block min-h-11 w-full bg-slate-900" maxLength={32} value={draft.number} onChange={(e) => setDraft({ ...draft, number: e.target.value })} /></label>
      <label>ID партнёра<input className="block min-h-11 w-full bg-slate-900" pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" value={draft.partnerId} onChange={(e) => setDraft({ ...draft, partnerId: e.target.value })} /></label>
      {(["dateFrom", "dateTo"] as const).map((key) => <label key={key}>{key === "dateFrom" ? "Начало периода" : "Конец периода"}
        <input className="block min-h-11 w-full bg-slate-900" type="datetime-local" value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /></label>)}
      <label><input type="checkbox" checked={draft.overdue} onChange={(e) => setDraft({ ...draft, overdue: e.target.checked })} /> Просроченные</label>
      <label><input type="checkbox" checked={draft.reconciliationPending} onChange={(e) => setDraft({ ...draft, reconciliationPending: e.target.checked })} /> Ожидают сверки резерва</label>
      <button className="min-h-11 rounded bg-blue-600 px-4">Применить фильтры</button></form>}
    {loading && <div aria-label="Загрузка заказов" className="h-24 animate-pulse rounded bg-slate-900" />}
    {!orderId && result && !blocked && <>
      {!result.items.length && <p>Заказов по выбранным фильтрам нет. Измените фильтры или обновите список.</p>}
      <ul className="space-y-3">{result.items.map((item) => <li key={item.id} className="rounded bg-slate-900 p-4">
        <Link className="inline-flex min-h-11 items-center underline" href={`/admin/orders/${item.id}`}>{item.publicNumber}</Link>
        <p>{labels[item.status]} · {money(item.totalMinor, item.currency)}{item.overdue ? " · Просрочен" : ""}</p></li>)}</ul>
      <nav aria-label="Страницы заказов" className="flex gap-4"><button className="min-h-11" disabled={result.page <= 1 || loading} onClick={() => turnPage(result.page - 1)}>Назад</button>
        <span>Страница {result.page}</span><button className="min-h-11" disabled={result.page * result.limit >= result.total || loading} onClick={() => turnPage(result.page + 1)}>Далее</button></nav></>}
    {order && !blocked && <>
      <h2 className="text-xl">{order.publicNumber}</h2><p>{labels[order.status]} · {money(order.totalMinor, order.currency)}{order.overdue ? " · Просрочен" : ""}</p>
      {["DELIVERED", "COMPLETED"].includes(order.status) && orderId &&
        <p><Link className="inline-flex min-h-11 items-center underline" href={`/admin/returns?order=${orderId}`}>Оформить возврат</Link></p>}
      <section><h2 className="font-semibold">Получатель</h2>{order.fulfillment && !order.fulfillment.redactedAt ? <>
        <p>{order.fulfillment.recipientName}</p><p>{order.fulfillment.phone}</p><p>{order.fulfillment.address}</p><p>{order.fulfillment.comment}</p></> : <p>Контактные данные не сохранены или удалены.</p>}</section>
      <section><h2 className="font-semibold">Товары</h2>{order.items?.map((item) => <article key={item.id} className="my-3 rounded bg-slate-900 p-4">
        <h3>{item.title} · {item.sku}</h3><p>{item.quantity} шт. × {money(item.unitPriceMinor, order.currency)} = {money(item.lineTotalMinor, order.currency)}</p>
        <p>{JSON.stringify(item.attributes)}</p><p>Комиссия за единицу: {money(item.partnerCommissionUnitMinor, order.currency)}</p>
        {item.supplierSettlementUnitMinor !== null && <p>Расчёт с поставщиком за единицу: {money(item.supplierSettlementUnitMinor, order.currency)}</p>}</article>)}</section>
      <section><h2 className="font-semibold">Атрибуция</h2><p>Партнёр: {order.partnerIdSnapshot ?? "Органический заказ"}</p>
        <p>Касание: {order.attributionTouchId ?? "Нет"}</p><p>Право на комиссию при создании: {order.commissionEligibleSnapshot ? "Да" : "Нет"}</p></section>
      <section><h2 className="font-semibold">Резервы</h2>{order.reservations?.map((r) => <div key={r.id} className="my-3 break-all rounded bg-slate-900 p-4">
        <p>{r.id} · {reservationLabels[r.status] ?? "Неизвестен"} · {r.quantity} шт.</p><p>Сверка: {r.reconciliationMethod === "MANUAL" ? "Ручная" : r.reconciliationMethod === "SOURCE_PROOF" ? "Подтверждение источника" : "Не выполнена"} {r.reconciliationReference}</p>
        <p>Источник: {sourceLabels[r.sourceStatus ?? ""] ?? "Нет данных"} · версия {r.sourceVersion ?? "Нет"}</p><p>Снимок: {r.lastSuccessfulSyncRunId ?? "Нет"}</p>
        {r.lastSuccessfulSyncAt && <p>Обновлён: {date(r.lastSuccessfulSyncAt)}</p>}
        {r.reconciledAt && <p>Сверен: {date(r.reconciledAt)} · администратор {r.reconciledByAdminUserId}
          · снимок {r.reconciliationInventorySyncRunId} · версия {r.reconciliationSourceVersion ?? "Нет"}</p>}
        {r.allowedManualTargets?.map((target) => <button key={target} className="min-h-11 rounded bg-blue-600 px-4"
          disabled={!!pending || loading || r.sourceStatus !== "OK" || !r.lastSuccessfulSyncRunId}
          onClick={() => { setReconcile({ id: r.id, target, snapshot: r.lastSuccessfulSyncRunId! }); setReason(""); setEvidence(""); setAttested(false); setConfirm(""); }}>
          {target === "CONSUMED" ? "Подтвердить списание резерва" : "Подтвердить возврат резерва"}</button>)}
        {reconcile?.id === r.id && <form aria-label="Сверка резерва" onSubmit={reconcileReservation} className="mt-3 space-y-3">
          <p>{reconcile.target === "CONSUMED" ? "Товар отгружен, и текущие остатки источника уже отражают списание." : "Товар возвращён, и текущие остатки источника уже отражают возврат."}</p>
          <label className="block">Причина сверки<textarea className="block w-full bg-slate-800" required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label className="block">Ссылка на подтверждение (необязательно)<input className="block min-h-11 w-full bg-slate-800" maxLength={500} value={evidence} onChange={(e) => setEvidence(e.target.value)} /></label>
          <label className="block"><input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} /> Подтверждаю, что показанный снимок остатков уже отражает физический результат.</label>
          <button className="min-h-11 rounded bg-blue-600 px-4" disabled={!!pending || loading || !attested || !reason.trim()}>Сохранить сверку</button>
          <button type="button" className="min-h-11 px-4 underline" disabled={!!pending} onClick={() => { setReconcile(null); setAttested(false); }}>Отмена сверки</button>
        </form>}</div>)}</section>
      <section><h2 className="font-semibold">История статусов</h2><ol>{order.timeline.map((item) => <li key={item.status}>{labels[item.status]} · {date(item.at)}</li>)}</ol>
        {order.completionEligibleAt && <p>Завершение системой возможно после {date(order.completionEligibleAt)}.</p>}</section>
      <section className="flex flex-wrap gap-3">{order.allowedTransitions.map((target) => <button key={target} className="min-h-11 rounded bg-blue-600 px-4"
        disabled={!!pending || loading} onClick={() => { setConfirm(target); setReconcile(null); setAttested(false); }}>{pending === target ? "Сохранение…" : actions[target]}</button>)}</section>
      {confirm && <section aria-label="Подтверждение действия" className="rounded border border-slate-600 p-4">
        <p>{actions[confirm]}?</p>{confirm === "DELIVERED" && <p>Подтвердите, что покупатель получил заказ.</p>}
        {confirm === "CANCELLED" && <p>Заказ будет отменён, его резервы освобождены.</p>}
        {confirm === "DELIVERY_FAILED" && <p>Резервы останутся активными до сверки с источником.</p>}
        <button className="min-h-11 px-4 underline" disabled={!!pending} onClick={() => void transition(confirm)}>Да, подтвердить</button>
        <button className="min-h-11 px-4 underline" onClick={() => setConfirm("")}>Вернуться</button></section>}
    </>}
  </div></main>;
}
