"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

const labels: Record<string, string> = { OPEN: "Открыт", COMPLETED: "Завершён", CANCELLED: "Отменён" };
type ReturnItem = { id: string; orderItemId: string; variantId: string; sku: string; title: string; quantity: number;
  unitPriceMinor: number; partnerCommissionUnitSnapshotMinor: number };
type ReturnDetail = { id: string; orderId: string; orderPublicNumber: string; status: string; reason: string; note: string | null;
  createdByAdminUserId: string; currency: string; items: ReturnItem[]; reversalPreviewMinor: number; createdAt: string; updatedAt: string };
type ReturnSummary = { id: string; orderId: string; orderPublicNumber: string; status: string; reason: string; note: string | null;
  itemCount: number; createdAt: string; updatedAt: string };
type Page = { items: ReturnSummary[]; total: number; page: number; limit: number };
type OrderView = { id: string; publicNumber: string; status: string; currency: string;
  items?: { id: string; title: string; sku: string; quantity: number; unitPriceMinor: number;
    partnerCommissionUnitMinor: number }[] };
const money = (value: number, currency: string) => new Intl.NumberFormat("ru-BY", { style: "currency", currency }).format(value / 100);
const date = (value: string) => new Date(value).toLocaleString("ru-BY");
const uuidPattern = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

export function AdminReturnsScreen({ csrfToken, returnId }: { csrfToken: string; returnId?: string }) {
  const router = useRouter();
  const token = useRef(csrfToken);
  const sequence = useRef(0);
  const busy = useRef(false);
  const [result, setResult] = useState<Page | null>(null);
  const [detail, setDetail] = useState<ReturnDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [pending, setPending] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [completionNote, setCompletionNote] = useState("");
  const [draft, setDraft] = useState({ status: "", orderId: "" });
  const [query, setQuery] = useState("page=1&limit=20");
  const [orderInput, setOrderInput] = useState("");
  const [order, setOrder] = useState<OrderView | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
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
        setBlocked(true); setResult(null); setDetail(null); setOrder(null);
        throw new Error(response.status === 401 ? "Откройте приложение заново через Telegram." : "Доступ запрещён. Управление возвратами недоступно.");
      }
      throw Object.assign(new Error(body.error?.code === "RETURN_QUANTITY_EXCEEDED"
        ? "Превышено доступное к возврату количество. Проверьте заказ и попробуйте снова."
        : body.error?.code === "RETURN_NOT_ALLOWED" ? "Возврат доступен только для доставленных или завершённых заказов."
        : body.error?.code === "NOT_FOUND" ? "Возврат не найден." : "Не удалось выполнить действие. Повторите попытку."), { code: body.error?.code });
    }
    return body;
  }, []);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    try {
      const body = await request(returnId ? `/api/v1/admin/returns/${encodeURIComponent(returnId)}` : `/api/v1/admin/returns?${query}`);
      if (current !== sequence.current) return;
      if (returnId) setDetail(body); else setResult(body);
      setError("");
    } catch (cause) { if (current === sequence.current) setError((cause as Error).message); }
    finally { if (current === sequence.current) setLoading(false); }
  }, [returnId, query, request]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      const preset = new URLSearchParams(window.location.search).get("order");
      if (!returnId && preset && new RegExp(`^${uuidPattern}$`).test(preset)) {
        setOrderInput(preset);
        void loadOrder(preset);
      }
      void refresh();
    });
    return () => { active = false; ++sequence.current; };
  }, [refresh, returnId]);
  useEffect(() => {
    const back = () => { if (window.history.length > 1) router.back(); else router.replace(returnId ? "/admin/returns" : "/shop"); };
    const button = window.Telegram?.WebApp?.BackButton;
    button?.show(); button?.onClick(back);
    return () => { button?.offClick(back); button?.hide(); };
  }, [returnId, router]);
  const filter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new URLSearchParams({ page: "1", limit: "20" });
    for (const [key, value] of Object.entries(draft)) if (value) values.set(key, String(value));
    setQuery(values.toString());
  };
  const loadOrder = async (orderId: string) => {
    if (busy.current || blocked || !new RegExp(`^${uuidPattern}$`).test(orderId)) {
      setOrder(null); setError("Введите корректный ID заказа."); return;
    }
    busy.current = true; setOrder(null); setQuantities({}); setError("");
    try {
      const body = await request(`/api/v1/admin/orders/${encodeURIComponent(orderId)}`);
      setOrder(body);
      if (body.status !== "DELIVERED" && body.status !== "COMPLETED")
        setError("Возврат доступен только для доставленных или завершённых заказов.");
    } catch (cause) { setError((cause as Error).message); }
    finally { busy.current = false; }
  };
  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!order || busy.current || blocked) return;
    const items = (order.items ?? []).map((item) => ({ orderItemId: item.id, quantity: quantities[item.id] ?? 0 }))
      .filter((item) => item.quantity > 0);
    if (!items.length) { setError("Укажите количество хотя бы для одной позиции."); return; }
    if (!reason.trim()) { setError("Укажите причину возврата."); return; }
    busy.current = true; setPending("create"); ++sequence.current;
    try {
      const created = await request("/api/v1/admin/returns", { orderId: order.id, reason: reason.trim(), items });
      setOrder(null); setQuantities({}); setReason(""); setOrderInput("");
      await router.push(`/admin/returns/${created.id}`);
    } catch (cause) { setError((cause as Error).message); }
    finally { busy.current = false; setPending(""); }
  };
  const cancelReturn = async () => {
    if (!returnId || busy.current || blocked || loading) return;
    busy.current = true; setPending("cancel"); ++sequence.current;
    try {
      await request(`/api/v1/admin/returns/${encodeURIComponent(returnId)}/cancel`, {});
      setConfirm(false); setError("");
      await refresh();
    } catch (cause) { setError((cause as Error).message); setConfirm(false); }
    finally { busy.current = false; setPending(""); }
  };
  const turnPage = (page: number) => { const next = new URLSearchParams(query); next.set("page", String(page)); setQuery(next.toString()); };
  const completeReturn = async () => {
    if (!returnId || busy.current || blocked || loading) return;
    busy.current = true; setPending("complete"); ++sequence.current;
    try {
      await request(`/api/v1/admin/returns/${encodeURIComponent(returnId)}/complete`,
        completionNote.trim() ? { note: completionNote.trim() } : {});
      setConfirmComplete(false); setError("");
      await refresh();
    } catch (cause) { setError((cause as Error).message); setConfirmComplete(false); }
    finally { busy.current = false; setPending(""); }
  };
  const preview = order && order.currency
    ? (order.items ?? []).reduce((sum, item) => sum + item.partnerCommissionUnitMinor * (quantities[item.id] ?? 0), 0) : 0;
  return <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100"><div className="mx-auto max-w-4xl space-y-5">
    <Link className="inline-flex min-h-11 items-center underline" href={returnId ? "/admin/returns" : "/shop"}>← {returnId ? "Все возвраты" : "Каталог"}</Link>
    <h1 className="text-2xl font-semibold">{returnId ? "Возврат" : "Возвраты администратора"}</h1>
    <nav className="flex gap-5" aria-label="Администрирование"><Link href="/admin">Обзор</Link><Link href="/admin/partners">Партнёры</Link><Link href="/admin/analytics">Аналитика</Link></nav>
    {error && <p role="alert" className="text-rose-300">{error}</p>}
    <button className="min-h-11 underline" disabled={!!pending || blocked} onClick={() => void refresh()}>Обновить</button>
    {!returnId && !blocked && <form onSubmit={filter} className="grid gap-3 sm:grid-cols-2">
      <label>Статус<select className="block min-h-11 w-full bg-slate-900" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
        <option value="">Все статусы</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>ID заказа<input className="block min-h-11 w-full bg-slate-900" pattern={uuidPattern} value={draft.orderId} onChange={(e) => setDraft({ ...draft, orderId: e.target.value })} /></label>
      <button className="min-h-11 rounded bg-blue-600 px-4">Применить фильтры</button></form>}
    {loading && <div aria-label="Загрузка возвратов" className="h-24 animate-pulse rounded bg-slate-900" />}
    {!returnId && result && !blocked && <>
      {!result.items.length && <p>Возвратов по выбранным фильтрам нет. Измените фильтры или обновите список.</p>}
      <ul className="space-y-3">{result.items.map((item) => <li key={item.id} className="rounded bg-slate-900 p-4">
        <Link className="inline-flex min-h-11 items-center underline" href={`/admin/returns/${item.id}`}>Возврат · {date(item.createdAt)}</Link>
        <p>{labels[item.status]} · заказ {item.orderPublicNumber} · позиций: {item.itemCount}</p>
        <p className="break-words">{item.reason}</p></li>)}</ul>
      <nav aria-label="Страницы возвратов" className="flex gap-4"><button className="min-h-11" disabled={result.page <= 1 || loading} onClick={() => turnPage(result.page - 1)}>Назад</button>
        <span>Страница {result.page}</span><button className="min-h-11" disabled={result.page * result.limit >= result.total || loading} onClick={() => turnPage(result.page + 1)}>Далее</button></nav>
      <section className="rounded bg-slate-900 p-4"><h2 className="text-xl font-semibold">Создать возврат</h2>
        <form aria-label="Выбор заказа для возврата" className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void loadOrder(orderInput); }}>
          <label>ID заказа<input className="block min-h-11 w-full bg-slate-800" pattern={uuidPattern} value={orderInput}
            onChange={(e) => setOrderInput(e.target.value)} /></label>
          <button className="min-h-11 rounded bg-blue-600 px-4" disabled={!!pending}>Загрузить заказ</button></form>
        {order && ["DELIVERED", "COMPLETED"].includes(order.status) && <form aria-label="Оформление возврата" onSubmit={submitCreate} className="mt-3 space-y-3">
          <p>Заказ {order.publicNumber} · {labels[order.status] ?? order.status}</p>
          {order.items?.map((item) => <div key={item.id} className="rounded bg-slate-800 p-3">
            <p>{item.title} · {item.sku} · в заказе {item.quantity} шт.</p>
            <p>Комиссия за единицу: {money(item.partnerCommissionUnitMinor, order.currency)}</p>
            <label>Количество к возврату<input className="block min-h-11 w-full bg-slate-900" type="number" min={0} max={item.quantity}
              value={quantities[item.id] ?? 0} onChange={(e) => setQuantities({ ...quantities, [item.id]: Math.max(0, Math.min(item.quantity, Number(e.target.value) || 0)) })} /></label></div>)}
          <p>Предполагаемый возврат комиссии: {money(preview, order.currency)} — применится при завершении возврата.</p>
          <label className="block">Причина возврата<textarea className="block w-full bg-slate-800" required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <button className="min-h-11 rounded bg-blue-600 px-4" disabled={!!pending || !Object.values(quantities).some((q) => q > 0)}>{pending === "create" ? "Сохранение…" : "Создать возврат"}</button>
          <button type="button" className="min-h-11 px-4 underline" disabled={!!pending} onClick={() => { setOrder(null); setQuantities({}); setReason(""); setOrderInput(""); }}>Сбросить</button>
        </form>}</section></>}
    {returnId && detail && !blocked && <>
      <h2 className="text-xl">Заказ <Link className="underline" href={`/admin/orders/${detail.orderId}`}>{detail.orderPublicNumber}</Link></h2>
      <p>{labels[detail.status]} · создан {date(detail.createdAt)} · администратор {detail.createdByAdminUserId}</p>
      <section><h2 className="font-semibold">Причина возврата</h2><p className="break-words">{detail.reason}</p>
        {detail.note && <p className="break-words">Комментарий: {detail.note}</p>}</section>
      <section><h2 className="font-semibold">Позиции</h2>{detail.items.map((item) => <article key={item.id} className="my-3 rounded bg-slate-900 p-4">
        <h3>{item.title} · {item.sku}</h3><p>{item.quantity} шт. × {money(item.unitPriceMinor, detail.currency)}</p>
        <p>Комиссия за единицу: {money(item.partnerCommissionUnitSnapshotMinor, detail.currency)}</p></article>)}</section>
      <p>{detail.status === "COMPLETED" ? "Возвращённая комиссия" : "Предполагаемый возврат комиссии"}: {money(detail.reversalPreviewMinor, detail.currency)}{detail.status === "OPEN" && " — применится при завершении возврата."}</p>
      {detail.status === "OPEN" && <section className="flex flex-wrap gap-3">
        <button className="min-h-11 rounded bg-blue-600 px-4" disabled={!!pending || loading} onClick={() => { setConfirm(false); setConfirmComplete(true); }}>{pending === "complete" ? "Сохранение…" : "Завершить возврат"}</button>
        <button className="min-h-11 rounded bg-rose-600 px-4" disabled={!!pending || loading} onClick={() => { setConfirmComplete(false); setConfirm(true); }}>{pending === "cancel" ? "Сохранение…" : "Отменить возврат"}</button></section>}
      {confirmComplete && detail.status === "OPEN" && <section aria-label="Подтверждение завершения возврата" className="rounded border border-slate-600 p-4">
        <p>Завершить возврат и списать комиссию {money(detail.reversalPreviewMinor, detail.currency)}? Уже выплаченная комиссия образует задолженность партнёра.</p>
        <label>Комментарий (необязательно)<textarea className="block w-full bg-slate-900" maxLength={1000} value={completionNote} onChange={(event) => setCompletionNote(event.target.value)} /></label>
        <button className="min-h-11 px-4 underline" disabled={!!pending} onClick={() => void completeReturn()}>Да, завершить возврат</button>
        <button className="min-h-11 px-4 underline" disabled={!!pending} onClick={() => setConfirmComplete(false)}>Вернуться</button></section>}
      {confirm && <section aria-label="Подтверждение отмены возврата" className="rounded border border-slate-600 p-4">
        <p>Отменить возврат? После отмены заказ снова сможет завершиться автоматически.</p>
        <button className="min-h-11 px-4 underline" disabled={!!pending} onClick={() => void cancelReturn()}>Да, отменить возврат</button>
        <button className="min-h-11 px-4 underline" onClick={() => setConfirm(false)}>Вернуться</button></section>}
    </>}
  </div></main>;
}
