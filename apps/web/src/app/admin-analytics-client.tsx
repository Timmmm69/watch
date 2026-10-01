"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { AdminDashboard, AnalyticsSummary } from "../../../../packages/contracts/src/index";

const percent = (value: number | null) => value === null ? "N/A" : `${(value * 100).toLocaleString("ru", { maximumFractionDigits: 1 })}%`;
const number = (value: number | null) => value === null ? "N/A" : value.toLocaleString("ru", { maximumFractionDigits: 2 });
const money = (value: number | null, currency: string) => value === null ? "N/A" :
  new Intl.NumberFormat("ru", { style: "currency", currency }).format(value / 100);
const inputClass = "min-h-11 rounded border border-slate-600 bg-slate-900 p-2";

export function AdminAnalyticsScreen({ dashboard = false }: { dashboard?: boolean }) {
  const router = useRouter();
  const [dates, setDates] = useState(() => ({ from: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }));
  const [query, setQuery] = useState(() => new URLSearchParams({ from: `${dates.from}T00:00:00Z`, to: `${dates.to}T00:00:00Z` }).toString());
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [operations, setOperations] = useState<AdminDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true); setError("");
    try {
      const send = () => fetch(dashboard ? "/api/v1/admin/dashboard" : `/api/v1/admin/analytics/summary?${query}`,
        { credentials: "same-origin", cache: "no-store" });
      let response = await send();
      if (response.status === 401) {
        const recovery = await fetch("/api/v1/auth/session", { credentials: "same-origin", cache: "no-store" });
        if (recovery.ok) response = await send();
      }
      if (current !== sequence.current) return;
      if (response.status === 401 || response.status === 403) {
        setBlocked(true); setSummary(null); setOperations(null);
        throw new Error(response.status === 401 ? "Откройте приложение заново через Telegram." : "Доступ разрешён только администратору.");
      }
      if (!response.ok) throw new Error(response.status === 400 ? "Укажите корректный период до 365 дней." : "Не удалось загрузить данные. Повторите попытку.");
      const data = await response.json();
      if (current !== sequence.current) return;
      if (dashboard) setOperations(data); else setSummary(data);
    } catch (failure) {
      if (current === sequence.current) setError(failure instanceof Error ? failure.message : "Не удалось загрузить данные.");
    } finally { if (current === sequence.current) setLoading(false); }
  }, [dashboard, query]);
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [load]);
  useEffect(() => {
    const button = window.Telegram?.WebApp?.BackButton;
    const back = () => { if (window.history.length > 1) router.back(); else router.replace(dashboard ? "/shop" : "/admin"); };
    button?.show(); button?.onClick(back);
    return () => { button?.offClick(back); button?.hide(); };
  }, [router, dashboard]);
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const span = Date.parse(dates.to) - Date.parse(dates.from);
    if (!(span > 0 && span <= 365 * 86400000)) { setError("Укажите корректный период до 365 дней."); return; }
    const next = new URLSearchParams({ from: `${dates.from}T00:00:00Z`, to: `${dates.to}T00:00:00Z` }).toString();
    if (next === query) void load(); else setQuery(next);
  }
  const cards: [string, string, string?][] = [];
  if (summary) {
    const s = summary;
    cards.push(["Заказы", number(s.orders)], ["Оборот", money(s.gmvMinor, s.currency)],
      ["Завершённые заказы с сохранёнными товарами", number(s.retainedCompletedOrders)],
      ["Активные продавцы", number(s.activeSellingPartners)], ["Сохранённые заказы на активного продавца", number(s.retainedOrdersPerActivePartner)],
      ["Реферальные переходы", number(s.referralTouches)], ["Конверсия переходов в заказ", percent(s.touchConversionRate)],
      ["Заказов на переход", number(s.ordersPerTouch)], ["Доставка", percent(s.deliveryRate)],
      ["Отмены", percent(s.cancellationRate)], ["Неуспешная доставка", percent(s.deliveryFailureRate)], ["Возвраты", percent(s.returnRate)],
      ["Комиссии после возвратов", money(s.netPartnerCommissionMinor, s.currency)],
      ["До первой сохранённой продажи, дней", number(s.firstSale.averageSeconds === null ? null : s.firstSale.averageSeconds / 86400)],
      ["Покрытие расчёта settlement", percent(s.contribution.coverageRate)],
      ["Маржа после settlement и комиссии", money(s.contribution.settlementMarginMinor, s.currency)],
      ["Маржа покрытых товаров", money(s.contribution.coveredUnits > 0 ? s.contribution.coveredSettlementMarginMinor : null, s.currency)], ["Полная contribution", "N/A"]);
  }
  if (operations) {
    const a = operations.actionable, s = operations.summaries;
    cards.push(["Новые заказы", number(a.placedOrders), "/admin/orders?status=PLACED"],
      ["Просроченные заказы", operations.overdueConfigured ? number(a.overdueOrders) : "SLA не настроен", "/admin/orders?overdue=true"],
      ["Сверка резервов", number(a.reconciliationPending), "/admin/orders?reconciliationPending=true"],
      ["Устаревшие остатки", number(a.staleInventory)], ["Неизвестные остатки", number(a.unknownInventory)], ["Дефицит остатков", number(a.inventoryDeficits)],
      ["Последняя синхронизация с ошибками", number(a.failedSyncs)], ["Открытые возвраты", number(a.openReturns), "/admin/returns"],
      ["Запрошенные выплаты", number(a.requestedPayouts), "/admin/payouts"], ["Ошибки обработки событий", number(a.failedEvents)],
      ["Ошибки обработки Telegram", number(a.failedTelegramUpdates)], ["Товары / активные", `${s.products} / ${s.activeProducts}`],
      ["Варианты товаров", number(s.variants)], ["Партнёры / активные / заблокированные", `${s.partners} / ${s.activePartners} / ${s.blockedPartners}`],
      ["Всего заказов", number(s.orders), "/admin/orders"], ["Всего возвратов", number(s.returns), "/admin/returns"], ["Всего выплат", number(s.payouts), "/admin/payouts"]);
  }
  return <main className="min-h-screen space-y-6 bg-slate-950 p-5 text-slate-100 sm:p-8">
    <nav aria-label="Администрирование" className="flex flex-wrap gap-5">
      <Link href="/admin">Обзор</Link><Link href="/admin/partners">Партнёры</Link><Link href="/admin/orders">Заказы</Link><Link href="/admin/returns">Возвраты</Link>
      <Link href="/admin/payouts">Выплаты</Link><Link href="/admin/inventory">Инвентарь</Link><Link href="/admin/analytics">Аналитика</Link><Link href="/admin/catalog">Каталог</Link><Link href="/shop">Магазин</Link>
    </nav>
    <h1 className="text-2xl font-semibold">{dashboard ? "Обзор администратора" : "Аналитика"}</h1>
    {!dashboard && !blocked && <form onSubmit={apply} className="flex flex-wrap items-end gap-4">
      <label className="grid gap-2">С даты (UTC)<input className={inputClass} type="date" required value={dates.from} onChange={e => setDates({ ...dates, from: e.target.value })} /></label>
      <label className="grid gap-2">До даты, не включая (UTC)<input className={inputClass} type="date" required value={dates.to} onChange={e => setDates({ ...dates, to: e.target.value })} /></label>
      <button className={inputClass} disabled={loading}>Применить</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    {!blocked && <button className={inputClass} onClick={() => void load()} disabled={loading}>Обновить</button>}
    {loading && <div role="status" aria-label="Загрузка показателей" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="h-24 animate-pulse rounded bg-slate-800" />)}</div>}
    {!loading && !blocked && <>
      {summary && summary.orders === 0 && summary.referralTouches === 0 && <p>В выбранном периоде нет заказов и реферальных переходов. Выберите другой период.</p>}
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{cards.map(([label, value, href]) => <div key={label} className="rounded border border-slate-700 p-4">
        <dt>{href ? <Link className="underline" href={href}>{label}</Link> : label}</dt><dd className="mt-3 text-2xl">{value}</dd></div>)}</dl>
      {summary && <section className="space-y-3"><h2 className="text-xl">Удержание партнёров по неделям</h2>
        <p>Полные соседние недели в часовом поясе {summary.timezone}. Активность учитывает право на комиссию на момент заказа.</p>
        {summary.weeklyRetention.length === 0 && <p>Для удержания выберите период с двумя полными неделями.</p>}
        {summary.weeklyRetention.map(w => <p key={w.week}>{w.week}: {percent(w.rate)} · {w.retainedPartners} из {w.activePartners}</p>)}
        <p>Заказы сгруппированы по дате создания. Переходы — по дате перехода; учитываются заказы до истечения перехода, включая заказы вне периода. N/A означает отсутствие знаменателя или данных о расходах.</p>
        <p>Первая продажа: от первого принятия условий до первого сохранённого завершённого заказа; учитываются первые продажи, завершённые в периоде ({summary.firstSale.partners}).</p>
        <p>Маржа рассчитана только по сохранённым товарам завершённых заказов с settlement. Полная contribution недоступна до определения переменных расходов U04.</p>
      </section>}
    </>}
  </main>;
}
