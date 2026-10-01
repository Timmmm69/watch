"use client";

import { useEffect, useState } from "react";

type Earnings = {
  currency: string; pendingAmountMinor: number; availableAmountMinor: number;
  total: number; page: number; limit: number;
  items: { id: string; orderPublicNumber: string; state: "PENDING" | "HOLD" | "EARNED" | "VOID";
    grossAmountMinor: number; reversedAmountMinor: number; netEarnedAmountMinor: number;
    createdAt: string; updatedAt: string; eligibleAt: string | null; availableAt: string | null }[];
};
const states = { PENDING: "Ожидает доставки", HOLD: "Период удержания", EARNED: "Начислена", VOID: "Аннулирована" };
const money = (amount: number, currency: string) => new Intl.NumberFormat("ru-BY", { style: "currency", currency }).format(amount / 100);

export function PartnerEarnings({ compact = false, blocked = false }: { compact?: boolean; blocked?: boolean }) {
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [data, setData] = useState<Earnings | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(false);
    void fetch(`/api/v1/partner/earnings?page=${page}&limit=${compact ? 3 : 20}`, {
      credentials: "same-origin", cache: "no-store", signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error("Earnings unavailable");
      return response.json() as Promise<Earnings>;
    }).then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [page, compact, retry]);

  return <section className="mb-6 rounded-xl bg-slate-900 p-4" aria-label="Партнёрские доходы">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Доходы</h2>
      {compact && <a className="min-h-11 content-center underline" href="/partner/earnings">Все начисления</a>}</div>
    {blocked && <p className="mt-3 text-amber-300">Партнёр заблокирован. История доходов доступна для просмотра.</p>}
    {error ? <div role="alert" className="mt-4 text-rose-300">Не удалось загрузить доходы.
      <button className="ml-3 min-h-11 underline" onClick={() => setRetry((n) => n + 1)}>Повторить</button></div>
      : !data ? <p role="status" className="mt-4 animate-pulse text-slate-400">Загрузка доходов…</p>
      : <>
        <dl className="my-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div><dt className="text-slate-400">Ожидается</dt><dd className="text-xl">{money(data.pendingAmountMinor, data.currency)}</dd></div>
          <div><dt className="text-slate-400">Доступно</dt><dd className="text-xl">{money(data.availableAmountMinor, data.currency)}</dd></div>
        </dl>
        {data.total === 0 ? <p className="text-slate-400">Продаж пока нет</p> : <>
          <h3 className="mb-3 font-medium">{compact ? "Последние изменения комиссий" : "История комиссий"}</h3>
          <ul className="space-y-3">{data.items.map((item) => <li key={item.id} className="rounded-lg border border-slate-700 p-3">
            <div className="flex flex-wrap justify-between gap-2"><span>Заказ {item.orderPublicNumber}</span><span>{states[item.state]}</span></div>
            <p className="mt-2">Комиссия: {money(item.grossAmountMinor, data.currency)}</p>
            <p>Отменено: {money(item.reversedAmountMinor, data.currency)}</p>
            <p>Начислено: {money(item.netEarnedAmountMinor, data.currency)}</p>
            <p className="mt-2 text-sm text-slate-400">Создана: <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("ru-BY")}</time></p>
            <p className="text-sm text-slate-400">Изменена: <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString("ru-BY")}</time></p>
          </li>)}</ul>
          {!compact && <nav aria-label="Страницы комиссий" className="mt-4 flex items-center gap-4">
            <button className="min-h-11 underline disabled:opacity-40" disabled={page === 1} onClick={() => setPage((n) => n - 1)}>Назад</button>
            <span>Страница {data.page}</span>
            <button className="min-h-11 underline disabled:opacity-40" disabled={page * data.limit >= data.total} onClick={() => setPage((n) => n + 1)}>Далее</button>
          </nav>}
        </>}
      </>}
  </section>;
}

export function EarningsScreen({ blocked }: { blocked: boolean }) {
  return <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100"><div className="mx-auto max-w-4xl">
    <div className="flex gap-4"><a className="inline-block min-h-11 underline" href="/shop">В каталог</a><a className="inline-block min-h-11 underline" href="/partner/payouts">Выплаты</a></div>
    <h1 className="mb-6 text-2xl font-semibold">Партнёрские доходы</h1>
    <PartnerEarnings blocked={blocked} />
  </div></main>;
}
