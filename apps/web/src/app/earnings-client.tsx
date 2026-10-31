"use client";

import { useEffect, useState } from "react";

type Earnings = {
  debtAmountMinor?: number; reversalAmountMinor?: number; payoutBlocked?: boolean;
  currency: string; pendingAmountMinor: number; availableAmountMinor: number;
  total: number; page: number; limit: number;
  items: { id: string; orderPublicNumber: string; state: "PENDING" | "HOLD" | "EARNED" | "VOID";
    grossAmountMinor: number; reversedAmountMinor: number; netEarnedAmountMinor: number;
    lockedAmountMinor: number; paidAmountMinor: number;
    createdAt: string; updatedAt: string; eligibleAt: string | null; availableAt: string | null }[];
};
const states = { PENDING: "Ожидаем завершения доставки", HOLD: "Идёт проверка после доставки", EARNED: "Начислено", VOID: "Аннулировано" };
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

  return <section className="app-panel mb-6" aria-label="Партнёрские доходы">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-bold">Доходы</h2>
      {compact && <a className="min-h-11 content-center underline" href="/partner/earnings">Все начисления</a>}</div>
    {blocked && <p className="mt-3 text-warning">Партнёрский аккаунт заблокирован. История начислений доступна для просмотра.</p>}
    {error ? <div role="alert" className="mt-4 text-danger">Не удалось загрузить начисления.
      <button className="ml-3 min-h-11 underline" onClick={() => setRetry((n) => n + 1)}>Повторить</button></div>
      : !data ? <p role="status" className="mt-4 animate-pulse text-muted">Загружаем начисления…</p>
      : <>
        {(data.debtAmountMinor ?? 0) > 0 && <p className="text-warning">Долг после корректировок: {money(data.debtAmountMinor!, data.currency)}.</p>}
        {(data.reversalAmountMinor ?? 0) > 0 && <p>Корректировки вознаграждений: {money(data.reversalAmountMinor!, data.currency)}. Подробности — в истории ниже.</p>}
        {data.payoutBlocked && <p>Выплата заблокирована до проверки оплаты и возвратов.</p>}
        <dl className="earnings-balances my-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div><dt className="text-muted">Ожидаемый заработок</dt><dd>{money(data.pendingAmountMinor, data.currency)}</dd></div>
          <div><dt className="text-muted">Доступно к выплате</dt><dd>{money(data.availableAmountMinor, data.currency)}</dd></div>
        </dl>
        <p className="mb-4 text-sm text-muted">Выплата зависит от доставки, подтверждённой оплаты и возвратов. Начисление может быть зарезервировано заявкой или уже выплачено. Актуальные ограничения проверяются при запросе выплаты.</p>
        {data.total === 0 ? <p className="text-muted">Начислений пока нет. После оформления заказа здесь появится ожидаемое вознаграждение.</p> : <>
          <h3 className="mb-3 font-bold">{compact ? "Последние начисления" : "История вознаграждений"}</h3>
          <ul className="space-y-3">{data.items.map((item) => <li key={item.id} className="app-panel">
            <div className="flex flex-wrap justify-between gap-2"><a className="min-h-11 underline" href={`/partner/orders/${encodeURIComponent(item.orderPublicNumber)}`}>Заказ {item.orderPublicNumber}</a><span>{states[item.state]}</span></div>
            <p className="mt-2">Вознаграждение при оформлении: {money(item.grossAmountMinor, data.currency)}</p>
            {item.reversedAmountMinor > 0 && <p>Скорректировано: {money(item.reversedAmountMinor, data.currency)}</p>}
            {item.state === "EARNED" && <p>Остаток в балансе: {money(item.netEarnedAmountMinor, data.currency)}</p>}
            {item.lockedAmountMinor > 0 && <p>В заявке на выплату: {money(item.lockedAmountMinor, data.currency)}</p>}
            {item.paidAmountMinor > 0 && <p>Выплачено: {money(item.paidAmountMinor, data.currency)}</p>}
            {item.eligibleAt && item.state === "HOLD" && <p>Проверка после доставки — до {new Date(item.eligibleAt).toLocaleDateString("ru-BY", { timeZone: "Europe/Minsk" })}. Это не дата выплаты: также нужны подтверждённая оплата и отсутствие мешающих возвратов.</p>}
            {item.availableAt && <p>Начислено в баланс: {new Date(item.availableAt).toLocaleString("ru-BY", { timeZone: "Europe/Minsk" })}</p>}
            <p className="mt-2 text-sm text-muted">Создана: <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("ru-BY")}</time></p>
            <p className="text-sm text-muted">Изменена: <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString("ru-BY")}</time></p>
          </li>)}</ul>
          {!compact && <nav aria-label="Страницы вознаграждений" className="mt-4 flex items-center gap-4">
            <button className="min-h-11 underline disabled:opacity-40" disabled={page === 1} onClick={() => setPage((n) => n - 1)}>Назад</button>
            <span>Страница {data.page}</span>
            <button className="min-h-11 underline disabled:opacity-40" disabled={page * data.limit >= data.total} onClick={() => setPage((n) => n + 1)}>Далее</button>
          </nav>}
        </>}
      </>}
  </section>;
}

export function EarningsScreen({ blocked }: { blocked: boolean }) {
  return <main className="app-shell min-h-dvh bg-canvas text-ink"><div className="mx-auto max-w-4xl">
    <div className="flex gap-4"><a className="inline-block min-h-11 underline" href="/partner">Партнёрский кабинет</a><a className="inline-block min-h-11 underline" href="/shop">В каталог</a><a className="inline-block min-h-11 underline" href="/partner/payouts">Выплаты</a></div>
    <h1 className="mb-6">Начисления</h1>
    <PartnerEarnings blocked={blocked} />
  </div></main>;
}
