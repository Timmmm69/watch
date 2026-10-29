"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { orderStatuses as statuses } from "./order-status";
import { ShopContact } from "./shop-contact";

interface OrderSummary {
  id: string; publicNumber: string; status: string; totalMinor: number; currency: string;
  itemCount: number; createdAt: string; commissionEligibleSnapshot?: boolean; salesChannel?: "DIRECT" | "REFERRAL" | "PARTNER";
}
interface OrderDetail extends OrderSummary {
  economicRegime?: "LEGACY_FIXED" | "DROPSHIP_MARKUP";
  timeline: { status: string; at: string }[];
  items: { id: string; title: string; sku: string; attributes: Record<string, unknown>; quantity: number;
    unitPriceMinor: number; lineTotalMinor: number; partnerCommissionUnitSnapshotMinor?: number; dropshipUnitPriceMinor?: number | null }[];
  fulfillment?: { recipientName: string | null; phone: string | null; address: string | null;
    comment: string | null; redactedAt: string | null } | null;
  supportContact: string;
}
const money = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;
const date = (value: string) => new Date(value).toLocaleString("ru-BY");
const channelLabel = (channel: NonNullable<OrderSummary["salesChannel"]>, partner: boolean) => channel === "DIRECT" ? "Покупка в магазине"
  : channel === "REFERRAL" ? partner ? "По вашей ссылке" : "Покупка по ссылке партнёра"
    : partner ? "Оформлен вами" : "Заказ оформлен продавцом";


export function OrdersScreen({ partner = false, blocked = false, publicNumber }: { partner?: boolean; blocked?: boolean; publicNumber?: string }) {
  const base = partner ? "/partner/orders" : "/orders";
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [salesChannel, setSalesChannel] = useState("");
  const [retry, setRetry] = useState(0);
  const [list, setList] = useState<{ items: OrderSummary[]; total: number; page: number; limit: number }>();
  const [detail, setDetail] = useState<OrderDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(undefined); setDetail(undefined); setList(undefined);
    const path = publicNumber ? `${base}/${encodeURIComponent(publicNumber)}` : `${base}?page=${page}&limit=20${status ? `&status=${status}` : ""}${partner && salesChannel ? `&salesChannel=${salesChannel}` : ""}`;
    void fetch(`/api/v1${path}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 404 ? "Заказ не найден." : response.status === 403 ? "Нет доступа к заказам." : "Не удалось загрузить заказы.");
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (publicNumber) setDetail(data); else setList(data);
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Не удалось загрузить заказы."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, publicNumber, page, status, salesChannel, retry, partner]);
  useEffect(() => {
    const back = window.Telegram?.WebApp?.BackButton;
    const handler = () => { window.location.href = publicNumber ? base : partner ? "/partner" : "/shop"; };
    back?.show(); back?.onClick(handler);
    return () => { back?.offClick(handler); back?.hide(); };
  }, [base, publicNumber, partner]);

  return <main className="app-shell min-h-dvh bg-canvas text-ink"><div className="mx-auto max-w-3xl">
    <nav className="mb-5 flex gap-4"><Link className="min-h-11 underline" href={publicNumber ? base : partner ? "/partner" : "/shop"}>{publicNumber ? "Все заказы" : partner ? "Партнёрский кабинет" : "В каталог"}</Link></nav>
    <h1 className="mb-6">{publicNumber ? `Заказ ${publicNumber}` : partner ? "Мои заказы" : "Мои заказы"}</h1>
    {blocked && <p className="mb-4 text-warning">Партнёрский аккаунт заблокирован. Доступен только просмотр истории.</p>}
    {!publicNumber && <div className="mb-4 grid gap-3 sm:grid-cols-2"><label className="block">Статус <select className="app-input min-h-11" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">Все</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {partner && <label className="block">Способ продажи <select className="app-input min-h-11" value={salesChannel} onChange={(event) => { setSalesChannel(event.target.value); setPage(1); }}><option value="">Все мои заказы</option><option value="PARTNER">Оформленные мной</option><option value="REFERRAL">Покупки по моим ссылкам</option></select></label>}</div>}
    {loading && <p role="status">Загрузка заказов…</p>}
    {error && <div><p role="alert">{error}</p><button className="min-h-11 underline" onClick={() => setRetry((n) => n + 1)}>Повторить</button></div>}
    {list && <>{list.total === 0 ? <p>Заказов пока нет.</p> : <ul className="space-y-3">{list.items.map((order) => <li key={order.id} className="app-panel">
      <Link className="inline-flex min-h-11 items-center underline" href={`${base}/${encodeURIComponent(order.publicNumber)}`}>Заказ {order.publicNumber}</Link>
      <p>{statuses[order.status] ?? order.status} · {money(order.totalMinor, order.currency)}</p><p>{order.salesChannel && channelLabel(order.salesChannel, partner)} · Товаров в заказе: {order.itemCount}</p>

      <time dateTime={order.createdAt}>{date(order.createdAt)}</time>
    </li>)}</ul>}
    <nav aria-label="Страницы заказов" className="mt-4 flex items-center gap-4"><button className="min-h-11 underline disabled:opacity-40" disabled={page === 1} onClick={() => setPage((n) => n - 1)}>Назад</button><span>Страница {list.page}</span><button className="min-h-11 underline disabled:opacity-40" disabled={page * list.limit >= list.total} onClick={() => setPage((n) => n + 1)}>Далее</button></nav></>}
    {detail && <>
      <p className="text-xl">{statuses[detail.status] ?? detail.status}{detail.salesChannel ? ` · ${channelLabel(detail.salesChannel, partner)}` : ""}</p>
      <h2 className="mt-5 text-lg font-bold">История статусов</h2><ol>{detail.timeline.map((entry) => <li key={entry.status}>{statuses[entry.status] ?? entry.status} · <time dateTime={entry.at}>{date(entry.at)}</time></li>)}</ol>
      <h2 className="mt-5 text-lg font-bold">Товары</h2><ul className="space-y-3">{detail.items.map((item) => <li key={item.id} className="app-panel">
        <p>{item.title} · {item.sku}</p><p>{Object.entries(item.attributes).map(([key, value]) => `${key}: ${String(value)}`).join(", ")}</p>
        <p>{item.quantity} шт. × {money(item.unitPriceMinor, detail.currency)} = {money(item.lineTotalMinor, detail.currency)}</p>
        {partner && <p>{detail.economicRegime === "DROPSHIP_MARKUP" ? "Ожидаемый заработок" : "Комиссия при оформлении"} за единицу: {money(item.partnerCommissionUnitSnapshotMinor ?? 0, detail.currency)}</p>}
        {partner && item.dropshipUnitPriceMinor != null && <p>Ваша цена при оформлении: {money(item.dropshipUnitPriceMinor, detail.currency)} · Цена покупателя при оформлении: {money(item.unitPriceMinor, detail.currency)}</p>}
      </li>)}</ul><p className="mt-5 text-xl">Итого: {money(detail.totalMinor, detail.currency)}</p>
      {partner && <><p>{detail.economicRegime === "DROPSHIP_MARKUP" ? "Вознаграждение при оформлении" : "Комиссия при оформлении"}: {detail.commissionEligibleSnapshot ? "предусмотрена" : "не предусмотрена"}</p><p>{detail.economicRegime === "DROPSHIP_MARKUP" ? "Ожидаемый заработок при оформлении" : "Комиссия при оформлении за заказ"}: {money(detail.items.reduce((sum, item) => sum + (item.partnerCommissionUnitSnapshotMinor ?? 0) * item.quantity, 0), detail.currency)}</p><Link className="inline-flex min-h-11 items-center underline" href="/partner/earnings">Состояние начислений и возвратов</Link><p className="text-sm text-muted">Расчёт при оформлении не учитывает последующие отмены, возвраты и выплаты. Текущее состояние смотрите в начислениях.</p></>}
      {(!partner || detail.salesChannel !== "REFERRAL") && <section className="mt-5"><h2 className="text-lg font-bold">Данные доставки</h2>
        {detail.fulfillment && !detail.fulfillment.redactedAt ? <dl>{Object.entries({ Получатель: detail.fulfillment.recipientName, Телефон: detail.fulfillment.phone, Адрес: detail.fulfillment.address, Комментарий: detail.fulfillment.comment }).map(([label, value]) => value && <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p>Данные доставки удалены.</p>}
        <p className="mt-4">Для изменения, отмены или возврата напишите в поддержку и укажите №{detail.publicNumber}.</p>
        <ShopContact contact={detail.supportContact} label="Написать по заказу" draft={`Здравствуйте! Обращаюсь по заказу №${detail.publicNumber}.`} />
      </section>}
    </>}
  </div></main>;
}
