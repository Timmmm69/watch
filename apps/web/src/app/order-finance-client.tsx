import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { OrderFinanceResponse } from "@watch/contracts";

const money = (n: number) => new Intl.NumberFormat("ru-BY", { style: "currency", currency: "BYN" }).format(n / 100);
const kinds: Record<string, string> = { RECEIPT: "Поступление", REFUND: "Возвращено покупателю", CORRECTION: "Сторно денежной записи",
  DELIVERY: "Доставка", PACKAGING: "Упаковка", PAYMENT_FEE: "Комиссия перевода", OTHER: "Другой прямой расход" };

export function OrderFinance({ orderId, request }: { orderId: string; request: (url: string, payload?: object) => Promise<unknown> }) {
  const [facts, setFacts] = useState<OrderFinanceResponse | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"money" | "expense">("money");
  const [kind, setKind] = useState("RECEIPT");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [original, setOriginal] = useState("");
  const [obligation, setObligation] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const busy = useRef(false);
  const endpoint = `/api/v1/admin/orders/${encodeURIComponent(orderId)}/finance`;
  const refresh = useCallback(async () => {
    setFacts(await request(endpoint) as OrderFinanceResponse);
  }, [endpoint, request]);
  useEffect(() => { void refresh().catch(e => setError((e as Error).message)); setOccurredAt(new Date().toISOString()); }, [refresh]);

  async function save(review = false) {
    if (busy.current || !confirmed || !facts) return;
    let payload: Record<string, unknown>;
    if (review) payload = { reason, confirmed, expenseEntryCount: facts.expenseEntryCount, reviewedTotalMinor: facts.recordedExpensesMinor };
    else payload = { kind, amountMinor: Number(amount), reference, reason, occurredAt, confirmed,
      ...(kind === "REFUND" ? { obligationId: obligation } : {}),
      ...(original ? mode === "money" ? { correctsEntryId: original } : { correctsExpenseId: original } : {}) };
    const signature = JSON.stringify({ mode: review ? "review" : mode, ...payload });
    if (retry.current?.signature !== signature) retry.current = { signature, key: crypto.randomUUID() };
    busy.current = true; setPending(true); setError("");
    try {
      const result = await request(`${endpoint}/${review ? "review" : mode}`, { ...payload, operationKey: retry.current.key });
      setFacts(result as OrderFinanceResponse); retry.current = null; setConfirmed(false); setAmount(""); setReference(""); setOriginal("");
    } catch (e) { setError((e as { code?: string }).code === "IDEMPOTENCY_CONFLICT" ? "Этот идентификатор уже использован с другими данными."
      : (e as { code?: string }).code ? "Запись не сохранена. Проверьте сумму, обязательство, исходную запись и безопасный reference." : (e as Error).message); }
    finally { busy.current = false; setPending(false); }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void save(); };
  const originals = mode === "money" ? facts?.money.filter(row => row.kind !== "CORRECTION" && !facts.money.some(c => c.correctsEntryId === row.id))
    : facts?.expenses.filter(row => row.amountMinor > 0 && !facts.expenses.some(c => c.correctsExpenseId === row.id));
  return <section aria-label="Фактические деньги" className="space-y-3 rounded border border-slate-600 p-4">
    <h2 className="text-xl font-semibold">Поступления, возвраты и расходы</h2>
    <p>Создание, подтверждение и доставка заказа не подтверждают оплату. Записывайте только проверенные фактические операции.</p>
    {error && <p role="alert" className="text-rose-300">{error}</p>}
    <button type="button" className="min-h-11 underline" disabled={pending} onClick={() => void refresh().catch(e => setError((e as Error).message))}>Обновить операции</button>
    {facts && <>
      <p>Остаток денежных поступлений: {money(facts.cashMinor)}. Товары у покупателя по R: {money(facts.retainedSalesMinor)}.</p>
      <p>Сумма к возврату покупателю: {money(facts.outstandingMinor)}. Денежное покрытие: {facts.covered ? "достаточное" : "недостаточное"}.</p>
      <p>Прямые расходы по заказу: {facts.expensesMinor === null ? "не проверены" : money(facts.expensesMinor)}. Записано: {money(facts.recordedExpensesMinor)}.</p>
      <ul>{facts.obligations.filter(o => o.outstandingMinor > 0).map(o => <li key={o.id}>{o.kind === "OVERPAYMENT" ? "Переплата" : "Возмещение возврата"}: {money(o.outstandingMinor)}</li>)}</ul>
      <ul aria-label="Поступления и возвраты денег">{facts.money.map(row => <li key={row.id} className="break-all">{kinds[row.kind]}: {money(row.amountMinor)} · {row.reference} · {row.occurredAt} · оператор {row.actorUserId}</li>)}</ul>
      <ul aria-label="Прямые расходы">{facts.expenses.map(row => <li key={row.id} className="break-all">{kinds[row.kind]}: {money(row.amountMinor)} · {row.reference} · {row.occurredAt} · оператор {row.actorUserId}</li>)}</ul>
      <form onSubmit={submit} className="space-y-3">
        <fieldset disabled={pending} className="space-y-3">
          <label className="block">Раздел учёта<select className="block min-h-11 w-full bg-slate-800" value={mode} onChange={e => { const next=e.target.value as typeof mode; setMode(next); setKind(next === "money" ? "RECEIPT" : "DELIVERY"); setOriginal(""); setAmount(""); }}><option value="money">Деньги покупателя</option><option value="expense">Прямой расход</option></select></label>
          <label className="block">Тип операции<select className="block min-h-11 w-full bg-slate-800" value={kind} onChange={e => { setKind(e.target.value); setOriginal(""); setAmount(""); }}>{(mode === "money" ? ["RECEIPT","REFUND","CORRECTION"] : ["DELIVERY","PACKAGING","PAYMENT_FEE","OTHER"]).map(k => <option key={k} value={k}>{kinds[k]}</option>)}</select></label>
          {(kind === "CORRECTION" || mode === "expense") && <label className="block">Запись для исправления<select className="block min-h-11 w-full bg-slate-800" required={kind === "CORRECTION"} value={original} onChange={e => { setOriginal(e.target.value); const row=originals?.find(r=>r.id===e.target.value); if(row) { setAmount(String(-row.amountMinor)); if(mode === "expense") setKind(row.kind); } }}><option value="">Новая операция</option>{originals?.map(row => <option key={row.id} value={row.id}>{row.reference} · {money(row.amountMinor)}</option>)}</select></label>}
          {kind === "REFUND" && <label className="block">Обязательство<select className="block min-h-11 w-full bg-slate-800" required value={obligation} onChange={e => setObligation(e.target.value)}><option value="">Выберите</option>{facts.obligations.filter(o=>o.outstandingMinor>0).map(o=><option key={o.id} value={o.id}>{o.kind === "OVERPAYMENT" ? "Переплата" : "Возврат"}: {money(o.outstandingMinor)}</option>)}</select></label>}
          <label className="block">Сумма в копейках BYN<input className="block min-h-11 w-full bg-slate-800" type="number" step="1" min="-2000000000" max="2000000000" required value={amount} onChange={e=>setAmount(e.target.value)} /></label>
          <p>Поступление/расход — положительная сумма; возмещение/сторно — отрицательная. Переплата не увеличивает наценку.</p>
          <label className="block">Дата и время операции (ISO с часовым поясом)<input className="block min-h-11 w-full bg-slate-800" required value={occurredAt} onChange={e=>setOccurredAt(e.target.value)} /></label>
          <label className="block">Внутренний идентификатор операции<input className="block min-h-11 w-full bg-slate-800" required maxLength={200} pattern="[A-Za-z][A-Za-z0-9._:-]*" value={reference} onChange={e=>setReference(e.target.value)} /></label>
          <p>Укажите идентификатор латиницей. Не вводите номера карт, счетов, пароли или ссылки.</p>
          <label className="block">Основание записи<textarea className="block w-full bg-slate-800" required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} /></label>
          <label className="block"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} /> Подтверждаю, что проверил данные операции или итог расходов</label>
          <button className="min-h-11 rounded bg-blue-600 px-4" disabled={!confirmed}>Сохранить операцию</button>
          <button type="button" className="block min-h-11 underline" disabled={!confirmed || !reason.trim()} onClick={()=>void save(true)}>Подтвердить проверенный итог расходов {money(facts.recordedExpensesMinor)}</button>
        </fieldset>
      </form>
    </>}
  </section>;
}
