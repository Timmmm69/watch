"use client";

import Link from "next/link";
import { OrderFinance } from "./order-finance-client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

const labels: Record<string, string> = { PLACED: "Создан", CONFIRMED: "Подтверждён", FULFILLING: "Собирается", SHIPPED: "Отправлен",
  DELIVERED: "Доставлен", COMPLETED: "Завершён", CANCELLED: "Отменён", DELIVERY_FAILED: "Не доставлен" };
const actions: Record<string, string> = { CONFIRMED: "Подтвердить заказ", FULFILLING: "Начать сборку", SHIPPED: "Подтвердить отправку",
  DELIVERED: "Подтвердить доставку покупателю", CANCELLED: "Отменить заказ" };
const reservationLabels: Record<string, string> = { ACTIVE: "Активен", RELEASED: "Освобождён", CONSUMED: "Использован" };
const sourceLabels: Record<string, string> = { OK: "Данные доступны", UNINITIALIZED: "Нет данных об остатке", MISSING: "Товар не найден в источнике остатков", INVALID: "Ошибка данных остатков" };
type Order = { id: string; publicNumber: string; status: string; totalMinor: number; currency: string; overdue: boolean;
  salesChannel?: "DIRECT" | "REFERRAL" | "PARTNER";
  economicRegime?: string; nativeInventory?: boolean;
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
  const [draft, setDraft] = useState(() => {
    const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
    return { status: params.get("status") ?? "", salesChannel: params.get("salesChannel") ?? "", number: "", partnerId: "", dateFrom: "", dateTo: "",
      overdue: params.get("overdue") === "true", reconciliationPending: params.get("reconciliationPending") === "true" };
  });
  const [query, setQuery] = useState(() => {
    const params = new URLSearchParams({ page: "1", limit: "20" });
    if (draft.status) params.set("status", draft.status);
    if (draft.overdue) params.set("overdue", "true");
    if (draft.reconciliationPending) params.set("reconciliationPending", "true");
    return params.toString();
  });
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
        setError(response.status === 401 ? "Откройте приложение заново через Telegram." : "Доступ запрещён. Изменение заказов недоступно.");
        throw new Error(response.status === 401 ? "Откройте приложение заново через Telegram." : "Доступ запрещён. Изменение заказов недоступно.");
      }
      throw Object.assign(new Error(body.error?.code === "INVENTORY_SNAPSHOT_CHANGED"
        ? "Данные об остатках изменились. Проверьте их и подтвердите действие ещё раз."
        : body.error?.code === "INVALID_ORDER_TRANSITION" ? "Статус заказа изменился. Обновите карточку перед следующим действием."
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
    <h1 className="text-2xl font-semibold">{orderId ? "Заказ" : "Управление заказами"}</h1>
    <nav className="flex gap-5" aria-label="Администрирование"><Link href="/admin">Обзор</Link><Link href="/admin/partners">Партнёры</Link><Link href="/admin/analytics">Аналитика</Link></nav>
    {error && <p role="alert" className="text-rose-300">{error}</p>}
    <button className="min-h-11 underline" disabled={!!pending || blocked} onClick={() => void refresh()}>Обновить</button>
    {!orderId && !blocked && <form onSubmit={filter} className="grid gap-3 sm:grid-cols-2">
      <label>Статус<select className="block min-h-11 w-full bg-slate-900" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
        <option value="">Все статусы</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Способ продажи<select className="block min-h-11 w-full bg-slate-900" value={draft.salesChannel} onChange={(e) => setDraft({ ...draft, salesChannel: e.target.value })}>
        <option value="">Все способы</option><option value="DIRECT">Покупка в магазине</option><option value="REFERRAL">Покупка по ссылке партнёра</option><option value="PARTNER">Оформлено продавцом</option></select></label>
      <label>Номер заказа<input className="block min-h-11 w-full bg-slate-900" maxLength={32} value={draft.number} onChange={(e) => setDraft({ ...draft, number: e.target.value })} /></label>
      <label>ID партнёра<input className="block min-h-11 w-full bg-slate-900" pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" value={draft.partnerId} onChange={(e) => setDraft({ ...draft, partnerId: e.target.value })} /></label>
      {(["dateFrom", "dateTo"] as const).map((key) => <label key={key}>{key === "dateFrom" ? "Начало периода" : "Конец периода"}
        <input className="block min-h-11 w-full bg-slate-900" type="datetime-local" value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /></label>)}
      <label><input type="checkbox" checked={draft.overdue} onChange={(e) => setDraft({ ...draft, overdue: e.target.checked })} /> Просроченные</label>
      <label><input type="checkbox" checked={draft.reconciliationPending} onChange={(e) => setDraft({ ...draft, reconciliationPending: e.target.checked })} /> Требуют сверки остатков</label>
      <button className="min-h-11 rounded bg-blue-600 px-4">Применить фильтры</button></form>}
    {loading && <div aria-label="Загрузка заказов" className="h-24 animate-pulse rounded bg-slate-900" />}
    {!orderId && result && !blocked && <>
      {!result.items.length && <p>По выбранным условиям заказов нет. Измените фильтры.</p>}
      <ul className="space-y-3">{result.items.map((item) => <li key={item.id} className="rounded bg-slate-900 p-4">
        <Link className="inline-flex min-h-11 items-center underline" href={`/admin/orders/${item.id}`}>{item.publicNumber}</Link>
        <p>{labels[item.status]} · {money(item.totalMinor, item.currency)}{item.overdue ? " · Просрочен" : ""}</p><p className="text-sm text-slate-400">{item.salesChannel === "DIRECT" ? "Покупка в магазине" : item.salesChannel === "REFERRAL" ? "Покупка по ссылке партнёра" : item.salesChannel === "PARTNER" ? "Оформлено продавцом" : "Исторический заказ"}</p></li>)}</ul>
      <nav aria-label="Страницы заказов" className="flex gap-4"><button className="min-h-11" disabled={result.page <= 1 || loading} onClick={() => turnPage(result.page - 1)}>Назад</button>
        <span>Страница {result.page}</span><button className="min-h-11" disabled={result.page * result.limit >= result.total || loading} onClick={() => turnPage(result.page + 1)}>Далее</button></nav></>}
    {order && !blocked && <>
      <h2 className="text-xl">{order.publicNumber}</h2><p>{labels[order.status]} · {money(order.totalMinor, order.currency)}{order.overdue ? " · Просрочен" : ""}</p><p>{order.salesChannel === "DIRECT" ? "Покупка в магазине" : order.salesChannel === "REFERRAL" ? "Покупка по ссылке партнёра" : order.salesChannel === "PARTNER" ? "Оформлено продавцом" : "Исторический заказ"}</p>
      {["SHIPPED", "DELIVERED", "COMPLETED"].includes(order.status) && orderId &&
        <p><Link className="inline-flex min-h-11 items-center underline" href={`/admin/returns?order=${orderId}`}>Оформить возврат</Link>
          {order.status === "SHIPPED" && " · В том числе отказ от получения или недоставка"}</p>}
      <section><h2 className="font-semibold">Получатель</h2>{order.fulfillment && !order.fulfillment.redactedAt ? <>
        <p>{order.fulfillment.recipientName}</p><p>{order.fulfillment.phone}</p><p>{order.fulfillment.address}</p><p>{order.fulfillment.comment}</p></> : <p>Контактные данные не сохранены или удалены.</p>}</section>
      <section><h2 className="font-semibold">Товары</h2>{order.items?.map((item) => <article key={item.id} className="my-3 rounded bg-slate-900 p-4">
        <h3>{item.title} · {item.sku}</h3><p>{item.quantity} шт. × {money(item.unitPriceMinor, order.currency)} = {money(item.lineTotalMinor, order.currency)}</p>
        <p>{JSON.stringify(item.attributes)}</p><p>{order.economicRegime === "DROPSHIP_MARKUP" ? "Наценка за единицу" : "Комиссия за единицу"}: {money(item.partnerCommissionUnitMinor, order.currency)}</p>
        {item.supplierSettlementUnitMinor !== null && <p>Расчёт с поставщиком за единицу: {money(item.supplierSettlementUnitMinor, order.currency)}</p>}</article>)}</section>
      <section><h2 className="font-semibold">Атрибуция</h2><p>Партнёр: {order.partnerIdSnapshot ?? "Органический заказ"}</p>
        <p>{order.economicRegime === "DROPSHIP_MARKUP" ? "Касание:" : "Реферальный переход:"} {order.attributionTouchId ?? (order.economicRegime === "DROPSHIP_MARKUP" ? "Нет" : "Нет реферального перехода")}</p><p>{order.economicRegime === "DROPSHIP_MARKUP" ? "Право на комиссию при создании:" : "Комиссия предусмотрена при оформлении:"} {order.commissionEligibleSnapshot ? "Да" : "Нет"}</p></section>
      <section><h2 className="font-semibold">Резервы</h2>{order.reservations?.map((r) => <div key={r.id} className="my-3 break-all rounded bg-slate-900 p-4">
        <p>{r.id} · {reservationLabels[r.status] ?? "Неизвестен"} · {r.quantity} шт.</p><p>Способ сверки: {r.reconciliationMethod === "MANUAL" ? "Ручная" : r.reconciliationMethod === "SOURCE_PROOF" ? "Подтверждение источника" : "Не выполнена"} {r.reconciliationReference}</p>
        <p>Источник: {sourceLabels[r.sourceStatus ?? ""] ?? "Нет данных"} · версия {r.sourceVersion ?? "Нет"}</p><p>Данные синхронизации: {r.lastSuccessfulSyncRunId ?? "Нет"}</p>
        {r.lastSuccessfulSyncAt && <p>Обновлён: {date(r.lastSuccessfulSyncAt)}</p>}
        {r.reconciledAt && <p>Сверен: {date(r.reconciledAt)} · администратор {r.reconciledByAdminUserId}
          · снимок {r.reconciliationInventorySyncRunId} · версия {r.reconciliationSourceVersion ?? "Нет"}</p>}
        {r.allowedManualTargets?.map((target) => <button key={target} className="min-h-11 rounded bg-blue-600 px-4"
          disabled={!!pending || loading || r.sourceStatus !== "OK" || !r.lastSuccessfulSyncRunId}
          onClick={() => { setReconcile({ id: r.id, target, snapshot: r.lastSuccessfulSyncRunId! }); setReason(""); setEvidence(""); setAttested(false); setConfirm(""); }}>
          {target === "CONSUMED" ? "Подтвердить списание резерва" : "Подтвердить возврат резерва"}</button>)}
        {reconcile?.id === r.id && <form aria-label="Сверка складского резерва" onSubmit={reconcileReservation} className="mt-3 space-y-3">
          <p>{reconcile.target === "CONSUMED" ? "Товар отгружен, и текущие остатки источника уже отражают списание." : "Товар возвращён, и текущие остатки источника уже отражают возврат."}</p>
          <label className="block">Причина корректировки<textarea className="block w-full bg-slate-800" required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label className="block">Ссылка на подтверждение (необязательно)<input className="block min-h-11 w-full bg-slate-800" maxLength={500} value={evidence} onChange={(e) => setEvidence(e.target.value)} /></label>
          <label className="block"><input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} /> Подтверждаю, что показанный снимок остатков уже отражает физический результат.</label>
          <button className="min-h-11 rounded bg-blue-600 px-4" disabled={!!pending || loading || !attested || !reason.trim()}>Сохранить сверку</button>
          <button type="button" className="min-h-11 px-4 underline" disabled={!!pending} onClick={() => { setReconcile(null); setAttested(false); }}>Закрыть форму сверки</button>
        </form>}</div>)}</section>
      {(order.nativeInventory || order.economicRegime === "DROPSHIP_MARKUP") && <OrderFinance orderId={order.id} request={request} />}
      <section><h2 className="font-semibold">История статусов</h2><ol>{order.timeline.map((item) => <li key={item.status}>{labels[item.status]} · {date(item.at)}</li>)}</ol>
        {order.completionEligibleAt && <p>Автоматическое завершение возможно не раньше {date(order.completionEligibleAt)}.</p>}</section>
      <section className="flex flex-wrap gap-3">{order.allowedTransitions.map((target) => <button key={target} className="min-h-11 rounded bg-blue-600 px-4"
        disabled={!!pending || loading} onClick={() => { setConfirm(target); setReconcile(null); setAttested(false); }}>{pending === target ? "Сохранение…" : actions[target]}</button>)}</section>
      {confirm && <section aria-label="Подтверждение действия" className="rounded border border-slate-600 p-4">
        <p>{actions[confirm]}?</p>{confirm === "DELIVERED" && <p>Подтвердите, что покупатель получил заказ.</p>}
        {confirm === "CANCELLED" && <p>Заказ будет отменён, его резервы освобождены.</p>}
        <button className="min-h-11 px-4 underline" disabled={!!pending} onClick={() => void transition(confirm)}>Подтвердить действие</button>
        <button className="min-h-11 px-4 underline" onClick={() => setConfirm("")}>Не менять статус</button></section>}
    </>}
  </div></main>;
}
