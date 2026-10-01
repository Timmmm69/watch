"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface OrderSummary {
  id: string; publicNumber: string; status: string; totalMinor: number; currency: string;
  itemCount: number; createdAt: string; commissionEligibleSnapshot?: boolean;
}
interface OrderDetail extends OrderSummary {
  timeline: { status: string; at: string }[];
  items: { id: string; title: string; sku: string; attributes: Record<string, unknown>; quantity: number;
    unitPriceMinor: number; lineTotalMinor: number; partnerCommissionUnitSnapshotMinor?: number }[];
  fulfillment?: { recipientName: string | null; phone: string | null; address: string | null;
    comment: string | null; redactedAt: string | null } | null;
  supportContact: string;
}
const statuses: Record<string, string> = { PLACED: "Оформлен", CONFIRMED: "Подтверждён", FULFILLING: "Собирается",
  SHIPPED: "Отправлен", DELIVERED: "Доставлен", COMPLETED: "Завершён", CANCELLED: "Отменён", DELIVERY_FAILED: "Не доставлен" };
const money = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;
const date = (value: string) => new Date(value).toLocaleString("ru-BY");

function supportUrl(contact: string): string | undefined {
  if (/^@[a-zA-Z0-9_]+$/.test(contact)) return `https://t.me/${contact.slice(1)}`;
  try { const url = new URL(contact); if (["https:", "http:", "mailto:", "tel:"].includes(url.protocol)) return url.href; } catch {}
  return undefined;
}

export function OrdersScreen({ partner = false, blocked = false, publicNumber }: { partner?: boolean; blocked?: boolean; publicNumber?: string }) {
  const base = partner ? "/partner/orders" : "/orders";
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [retry, setRetry] = useState(0);
  const [list, setList] = useState<{ items: OrderSummary[]; total: number; page: number; limit: number }>();
  const [detail, setDetail] = useState<OrderDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(undefined); setDetail(undefined); setList(undefined);
    const path = publicNumber ? `${base}/${encodeURIComponent(publicNumber)}` : `${base}?page=${page}&limit=20${status ? `&status=${status}` : ""}`;
    void fetch(`/api/v1${path}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 404 ? "Заказ не найден." : response.status === 403 ? "Нет доступа к заказам." : "Не удалось загрузить заказы.");
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (publicNumber) setDetail(data); else setList(data);
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Не удалось загрузить заказы."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, publicNumber, page, status, retry]);
  useEffect(() => {
    const back = window.Telegram?.WebApp?.BackButton;
    const handler = () => { window.location.href = publicNumber ? base : partner ? "/partner" : "/shop"; };
    back?.show(); back?.onClick(handler);
    return () => { back?.offClick(handler); back?.hide(); };
  }, [base, publicNumber, partner]);
  const support = detail && supportUrl(detail.supportContact);
  return <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100"><div className="mx-auto max-w-3xl">
    <nav className="mb-5 flex gap-4"><Link className="min-h-11 underline" href={publicNumber ? base : partner ? "/partner" : "/shop"}>{publicNumber ? "Все заказы" : partner ? "Партнёрский кабинет" : "В каталог"}</Link></nav>
    <h1 className="mb-6 text-2xl font-semibold">{publicNumber ? `Заказ ${publicNumber}` : partner ? "Партнёрские заказы" : "Мои заказы"}</h1>
    {blocked && <p className="mb-4 text-amber-300">Партнёр заблокирован. Доступен только просмотр истории.</p>}
    {!publicNumber && <label className="mb-4 block">Статус <select className="min-h-11 rounded bg-slate-900 p-2" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">Все</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
    {loading && <p role="status">Загрузка заказов…</p>}
    {error && <div><p role="alert">{error}</p><button className="min-h-11 underline" onClick={() => setRetry((n) => n + 1)}>Повторить</button></div>}
    {list && <>{list.total === 0 ? <p>Заказов пока нет</p> : <ul className="space-y-3">{list.items.map((order) => <li key={order.id} className="rounded-xl bg-slate-900 p-4">
      <Link className="inline-flex min-h-11 items-center underline" href={`${base}/${encodeURIComponent(order.publicNumber)}`}>Заказ {order.publicNumber}</Link>
      <p>{statuses[order.status] ?? order.status} · {money(order.totalMinor, order.currency)}</p><p>Позиций: {order.itemCount}</p>
      {partner && <p>Комиссия по снимку: {order.commissionEligibleSnapshot ? "предусмотрена" : "не предусмотрена"}</p>}
      <time dateTime={order.createdAt}>{date(order.createdAt)}</time>
    </li>)}</ul>}
    <nav aria-label="Страницы заказов" className="mt-4 flex items-center gap-4"><button className="min-h-11 underline disabled:opacity-40" disabled={page === 1} onClick={() => setPage((n) => n - 1)}>Назад</button><span>Страница {list.page}</span><button className="min-h-11 underline disabled:opacity-40" disabled={page * list.limit >= list.total} onClick={() => setPage((n) => n + 1)}>Далее</button></nav></>}
    {detail && <>
      <p className="text-xl">{statuses[detail.status] ?? detail.status}</p>
      <h2 className="mt-5 text-lg font-semibold">История статусов</h2><ol>{detail.timeline.map((entry) => <li key={entry.status}>{statuses[entry.status] ?? entry.status} · <time dateTime={entry.at}>{date(entry.at)}</time></li>)}</ol>
      <h2 className="mt-5 text-lg font-semibold">Товары</h2><ul className="space-y-3">{detail.items.map((item) => <li key={item.id} className="rounded-xl bg-slate-900 p-4">
        <p>{item.title} · {item.sku}</p><p>{Object.entries(item.attributes).map(([key, value]) => `${key}: ${String(value)}`).join(", ")}</p>
        <p>{item.quantity} шт. × {money(item.unitPriceMinor, detail.currency)} = {money(item.lineTotalMinor, detail.currency)}</p>
        {partner && <p>Комиссия по снимку за единицу: {money(item.partnerCommissionUnitSnapshotMinor ?? 0, detail.currency)}</p>}
      </li>)}</ul><p className="mt-5 text-xl">Итого: {money(detail.totalMinor, detail.currency)}</p>
      {partner && <><p>Комиссия по снимку: {detail.commissionEligibleSnapshot ? "предусмотрена" : "не предусмотрена"}</p><p>Комиссия по снимку за заказ: {money(detail.items.reduce((sum, item) => sum + (item.partnerCommissionUnitSnapshotMinor ?? 0) * item.quantity, 0), detail.currency)}</p><Link className="inline-flex min-h-11 items-center underline" href="/partner/earnings">Состояние начислений и возвратов</Link></>}
      {!partner && <section className="mt-5"><h2 className="text-lg font-semibold">Данные доставки</h2>
        {detail.fulfillment && !detail.fulfillment.redactedAt ? <dl>{Object.entries({ Получатель: detail.fulfillment.recipientName, Телефон: detail.fulfillment.phone, Адрес: detail.fulfillment.address, Комментарий: detail.fulfillment.comment }).map(([label, value]) => value && <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p>Данные доставки удалены.</p>}
        <p className="mt-4">Для отмены или возврата свяжитесь с оператором и укажите номер заказа.</p>
        {support ? <a className="inline-flex min-h-11 items-center underline" href={support}>Связаться по заказу</a> : <p>Связаться по заказу: {detail.supportContact}</p>}
      </section>}
    </>}
  </div></main>;
}
