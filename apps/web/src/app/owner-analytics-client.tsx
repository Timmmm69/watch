"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { OwnerReport, OwnerWork, OwnerQueue } from "../../../../packages/contracts/src/index";

const inputClass = "min-h-11 rounded border border-control bg-surface-muted p-2";
const queueLabels: Record<OwnerQueue,string> = { new:"Новые заказы",overdue:"Заказы с задержкой",unpaid:"Оплата не подтверждена после доставки",
  returns:"Возвраты: обработка, приёмка или возмещение",payouts:"Выплаты к обработке",inventory:"Ошибки склада" };
const minskDate = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone:"Europe/Minsk",year:"numeric",month:"2-digit",day:"2-digit" }).format(date);
const shift = (date: string, days: number) => new Date(Date.parse(date)+days*86400000).toISOString().slice(0,10);
// Date input represents Minsk midnight; the end is exclusive.
const params = (dates: {from:string;to:string}) => new URLSearchParams({from:`${dates.from}T00:00:00+03:00`,to:`${dates.to}T00:00:00+03:00`}).toString();
const money = (n: number|null, currency: string) => n===null ? "Нет данных" : new Intl.NumberFormat("ru-BY",{style:"currency",currency}).format(n/100);
const percent = (n: number|null) => n===null ? "Нет данных" : `${(n*100).toLocaleString("ru-BY",{maximumFractionDigits:1})}%`;

function ReportTable({ label, headers, children }: {label:string;headers:string[];children:ReactNode}) {
  return <div className="max-w-full overflow-x-auto" role="region" aria-label={label} tabIndex={0}>
    <table style={{minWidth:headers.length>5 ? 1100 : 760}} className="w-full border-collapse text-left text-sm"><caption className="py-3 text-left text-xl">{label}</caption>
      <thead><tr>{headers.map(h=><th className="border-b border-control p-3" scope="col" key={h}>{h}</th>)}</tr></thead>
      <tbody>{children}</tbody></table></div>;
}
const cell = "border-b border-hairline p-3 align-top";

export function OwnerAnalyticsScreen({ dashboard=false }: {dashboard?:boolean}) {
  const router=useRouter(), search=useSearchParams();
  const queue=search.get("queue"), page=Number(search.get("page")??1);
  const [dates,setDates]=useState(()=>{const to=shift(minskDate(new Date()),1); return {from:shift(to,-30),to};});
  const [query,setQuery]=useState(()=>params(dates));
  const [report,setReport]=useState<OwnerReport|null>(null), [work,setWork]=useState<OwnerWork|null>(null);
  const [loading,setLoading]=useState(true), [error,setError]=useState(""), [blocked,setBlocked]=useState(false);
  const sequence=useRef(0);
  const load=useCallback(async()=>{
    const current=++sequence.current; setLoading(true); setError(""); setReport(null); setWork(null);
    try {
      const url=queue ? `/api/v1/admin/analytics/work?${new URLSearchParams({queue,page:String(page)})}` : `/api/v1/admin/analytics/owner?${query}`;
      const send=()=>fetch(url,{credentials:"same-origin",cache:"no-store"});
      let response=await send();
      if (response.status===401) { const recovery=await fetch("/api/v1/auth/session",{credentials:"same-origin",cache:"no-store"}); if(recovery.ok) response=await send(); }
      if(current!==sequence.current) return;
      if(response.status===401 || response.status===403) { setBlocked(true); throw new Error(response.status===403 ? "Доступ разрешён только администратору." : "Откройте приложение заново через Telegram."); }
      if(!response.ok) throw new Error(response.status===400 ? "Укажите корректный период до 365 дней или рабочую очередь." : "Не удалось загрузить данные. Повторите попытку.");
      const data=await response.json(); if(current!==sequence.current) return;
      if(queue) setWork(data); else setReport(data);
    } catch(failure) { if(current===sequence.current) setError(failure instanceof Error ? failure.message : "Не удалось загрузить данные."); }
    finally { if(current===sequence.current) setLoading(false); }
  },[query,queue,page]);
  useEffect(()=>{void load();return()=>{sequence.current++;};},[load]);
  useEffect(()=>{const button=window.Telegram?.WebApp?.BackButton;
    const back=()=>{if(window.history.length>1) router.back();else router.replace(dashboard ? "/shop" : "/admin");};
    button?.show();button?.onClick(back);return()=>{button?.offClick(back);button?.hide();};},[router,dashboard]);
  function apply(event:FormEvent) { event.preventDefault(); const days=(Date.parse(dates.to)-Date.parse(dates.from))/86400000;
    if(!(days>0 && days<=365)) {setError("Укажите корректный период до 365 дней.");return;}
    const next=params(dates); if(next===query) void load();else setQuery(next);
  }
  const c=report?.cohort, fmt=(n:number|null)=>money(n,report?.currency??"BYN");
  const coverage=(v:OwnerReport["cohort"]["contribution"])=> <>{fmt(v.fullMinor)}<br/><span className="text-xs text-muted">
    Покрытая часть: {fmt(v.coveredMinor)} · {v.coveredOrders}/{v.closedOrders} закрытых заказов</span></>;
  const settlement=(v:OwnerReport["obligations"])=> <>Ожидается {fmt(v.pendingMinor)}<br/>Доступно по журналу {fmt(v.availableMinor)}<br/>
    Заблокировано в заявках {fmt(v.lockedMinor)}<br/>Выплачено {fmt(v.paidMinor)}<br/>Долг {fmt(v.debtMinor)}
    {v.payoutBlocked && <p className="text-warning">Текущие факты блокируют новую выплату. Проверьте оплату и возвраты.</p>}</>;
  return <main className="min-h-screen min-w-0 space-y-6 bg-canvas p-5 text-ink sm:p-8">
    <nav aria-label="Администрирование" className="flex flex-wrap gap-5"><Link href="/admin">Обзор</Link><Link href="/admin/orders">Заказы</Link>
      <Link href="/admin/returns">Возвраты</Link><Link href="/admin/payouts">Выплаты</Link><Link href="/admin/inventory">Склад</Link>
      <Link href="/admin/partners">Партнёры</Link><Link href="/admin/analytics">Аналитика</Link><Link href="/shop">Магазин</Link></nav>
    <h1 className="text-2xl font-bold">{queue ? "Рабочая очередь" : dashboard ? "Рабочий обзор владельца" : "Аналитика владельца"}</h1>
    {!blocked && !queue && <form onSubmit={apply} className="flex flex-wrap items-end gap-4">
      <label className="grid gap-2">С даты (Минск)<input type="date" className={inputClass} required value={dates.from} onChange={e=>setDates({...dates,from:e.target.value})}/></label>
      <label className="grid gap-2">До даты, не включая (Минск)<input type="date" className={inputClass} required value={dates.to} onChange={e=>setDates({...dates,to:e.target.value})}/></label>
      <button className={inputClass} disabled={loading}>Применить</button>
      {[7,30].map(days=><button className={inputClass} key={days} type="button" disabled={loading} onClick={()=>{
        const to=shift(minskDate(new Date()),1), next={from:shift(to,-days),to};setDates(next);setQuery(params(next));}}>Последние {days} дней</button>)}
    </form>}
    {!blocked && <button className={inputClass} disabled={loading} onClick={()=>void load()}>Обновить</button>}
    {error && <p role="alert">{error}</p>}{loading && <p role="status">Загружаем показатели…</p>}
    {!blocked && work && <section className="space-y-4" aria-label="Список рабочей очереди"><h2 className="text-xl">{queueLabels[work.queue]} · {work.total}</h2>
      <p>Показаны все текущие задачи независимо от даты создания.</p>
      {work.total===0 && <p>Задач, требующих действия, сейчас нет.</p>}
      <ul className="space-y-3">{work.items.map(i=><li key={i.id} className="rounded-xl border border-hairline p-4"><Link className="underline" href={i.href}>{i.label}</Link><p className="break-words">{i.detail}</p></li>)}</ul>
      <div className="flex flex-wrap gap-5">{work.page>1 && <Link href={`/admin/analytics?queue=${work.queue}&page=${work.page-1}`}>Назад</Link>}
        <span>Страница {work.page}</span>{work.page*work.limit<work.total && <Link href={`/admin/analytics?queue=${work.queue}&page=${work.page+1}`}>Далее</Link>}</div>
    </section>}
    {!blocked && report && c && <>
      <section aria-label="Рабочие очереди" className="space-y-3"><h2 className="text-xl">Что требует действия сейчас</h2><p>Все даты; по состоянию на {new Date(report.asOf).toLocaleString("ru-BY",{timeZone:"Europe/Minsk"})} (Минск).</p>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{(Object.keys(queueLabels) as OwnerQueue[]).map(key=><div className="rounded-xl border border-hairline p-4" key={key}>
          <dt><Link className="underline" href={`/admin/analytics?queue=${key}`}>{queueLabels[key]}</Link></dt>
          <dd className="mt-2 text-2xl">{key==='overdue' && !report.overdueConfigured ? "Срок обработки не настроен" : report.queues[key]}</dd></div>)}</dl>
      </section>
      <section className="space-y-3" aria-label="Результаты когорты"><h2 className="text-xl">Заказы по дате создания · Europe/Minsk</h2>
        <p>Текущие исходы заказов выбранного периода. Незавершённые заказы, включая доставленные с hold, показаны отдельно. Поздние возвраты уточняют эту же когорту.</p>
        {c.orders===0 && <p>В выбранном периоде нет новых заказов.</p>}
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[
          ["Создано заказов",c.orders], ["Стоимость созданных заказов",fmt(c.createdValueRMinor)],
          ["Незавершённые заказы",c.unfinishedOrders], ["Удержанные завершённые заказы / единицы",`${c.retainedOrders} / ${c.retainedUnits}`],
          ["Розничная стоимость удержанных товаров",fmt(c.retainedRMinor)], ["Удержанные продажи за вычетом комиссии",fmt(c.retainedDMinor)],
          ["Комиссии удержанных продаж",fmt(c.markupMinor)], ["Отмены / невыкупы",`${c.cancelledOrders} / ${c.failedOrders}`],
          ["Заказы с возвратами / единицы",`${c.returnedOrders} / ${c.returnedUnits}`], ["Доля отмен среди созданных",percent(c.cancellationRate)],
          ["Возвраты среди доставленных",percent(c.returnRate)]
        ].map(([label,value])=><div className="rounded-xl border border-hairline p-4" key={label}><dt>{label}</dt><dd className="mt-2 text-xl">{value}</dd></div>)}</dl>
        <h3 className="text-lg">Вклад владельца по закрытым заказам</h3><p>{coverage(c.contribution)}</p>
        <p>Продажи за вычетом комиссии − закупка отправленных товаров + стоимость принятых пригодных возвратов − фактические прямые расходы.
          Сюда входят потери и расходы отмен/невыкупов этой когорты. Потери не вычитаются повторно. Это вклад до налогов и постоянных расходов.</p>
        <p>Неизвестная закупка, непроверенные расходы, открытый возврат или незавершённая приёмка делают полный вклад недоступным. Проверенный нулевой расход учитывается как 0.</p>
        {report.legacyOrdersExcluded>0 && <p>Исторические заказы прежней модели в периоде: {report.legacyOrdersExcluded}. Исключены из новой экономики; доступны в списке заказов.</p>}
      </section>
      <section aria-label="Обязательства партнёрам" className="space-y-3"><h2 className="text-xl">Расчёты с партнёрами · все даты</h2><p>{settlement(report.obligations)}</p>
        <p>Текущие балансы существующего журнала, включая исторические начисления. Долг считается по каждому партнёру и не скрывается доходами других. Выплачено — подтверждённые переводы за всё время; позднее сторно не переписывает их.</p>
      </section>
      <section className="space-y-3" aria-label="Потоки за период"><h2 className="text-xl">Отдельные потоки за выбранный период</h2>
        <p>Фактические доставки по delivered_at: {report.deliveries.orders} заказов / {report.deliveries.units} единиц до последующих возвратов.</p>
        <p>Денежные операции по фактической дате: получено {fmt(report.cash.receiptsMinor)}, возвращено {fmt(report.cash.refundsMinor)}, корректировки {fmt(report.cash.correctionsMinor)}, нетто {fmt(report.cash.netMinor)}.</p>
        <p>Эти потоки могут относиться к заказам других периодов; они не входят в формулу вклада выбранной когорты.</p>
      </section>
      <p>Проведите по таблице в сторону, чтобы увидеть остальные столбцы.</p>
      <ReportTable label="Товары (SKU)" headers={["SKU / модель","Остаток / резерв / доступно сейчас","Удержанные единицы / продажи за вычетом комиссии","Возвраты / отменённые единицы","Вклад владельца"]}>
        {report.skus.map(s=><tr key={s.variantId}><th scope="row" className={cell}><Link className="underline" href={`/admin/products/${s.productId}`}>{s.sku}</Link><p>{s.title}</p></th>
          <td className={cell}>{s.onHand??"Нет данных"} / {s.reserved} / {s.sellable??"Нет данных"}</td><td className={cell}>{s.retainedUnits} / {fmt(s.retainedDMinor)}</td>
          <td className={cell}>{s.returnedUnits} / {s.cancelledUnits}</td><td className={cell}>{coverage(s.contribution)}</td></tr>)}
      </ReportTable>
      <p>Остаток — текущий, продажи — когорта периода. Таблица помогает пополнять продающиеся SKU и разбирать возвраты. Отсутствие продаж без истории доступности не доказывает залежалость.
        Общие расходы заказа распределены между SKU по исходным единицам с сохранением копеек; покрытие — по полностью известным заказам.</p>
      <ReportTable label="Партнёры" headers={["Партнёр","Создано / незавершено / доставлено","Удержанные заказы / единицы / продажи за вычетом комиссии","Вклад владельца","Комиссии удержанных продаж","Отмены / невыкупы / возвраты","Расчёты · все даты"]}>
        {report.drops.map(d=><tr key={d.partnerId}><th scope="row" className={cell}><Link className="underline" href={`/admin/partners/${d.partnerId}`}>{d.name}</Link></th>
          <td className={cell}>{d.orders} / {d.unfinishedOrders} / {d.deliveredOrders}</td><td className={cell}>{d.retainedOrders} / {d.retainedUnits} / {fmt(d.retainedDMinor)}</td>
          <td className={cell}>{coverage(d.contribution)}</td><td className={cell}>{fmt(d.markupMinor)}</td><td className={cell}>{d.cancelledOrders} / {d.failedOrders} / {d.returnedOrders} ({d.returnedUnits} ед.)</td>
          <td className={cell}>{settlement(d.obligations)}</td></tr>)}
      </ReportTable>
      <p>Сравнивайте удержанные результаты и вклад партнёров; свежие незавершённые заказы требуют наблюдения. Причины отмен и возвратов доступны в рабочих очередях и карточках.</p>
      <ReportTable label="Сверка с заказами когорты" headers={["Заказ / исход","Удержанные единицы / розница / за вычетом комиссии","Вклад / качество данных"]}>
        {report.orders.map(o=><tr key={o.id}><th scope="row" className={cell}><Link className="underline" href={`/admin/orders/${o.id}`}>{o.number}</Link><p>{o.status}</p></th>
          <td className={cell}>{o.retainedUnits} / {fmt(o.retainedRMinor)} / {fmt(o.retainedDMinor)}</td><td className={cell}>{fmt(o.contributionMinor)}<p>{o.limitations.join("; ")}</p></td></tr>)}
      </ReportTable>
    </>}
  </main>;
}
