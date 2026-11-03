"use client";
import { useEffect, useRef, useState } from "react";
import {
  Field,
  buttonClass,
  inputClass,
  useAdminCatalogApi,
} from "./admin-catalog-common";
type Stock = {
  onHand: number;
  reserved: number;
  buffer: number;
  available: number;
  initialized: boolean;
  history: {
    id: string;
    kind: string;
    delta: number;
    onHandAfter: number;
    reason: string;
    occurredAt: string;
    actor: string;
  }[];
};
const kinds: Record<string, string> = {
  INITIALIZATION: "Начальный остаток",
  RECEIPT: "Поступление",
  CORRECTION: "Корректировка",
  RESERVE: "Резерв заказа",
  RELEASE: "Отмена резерва",
  SHIPMENT: "Отправка",
  RETURN_INSPECTION: "Возврат",
  VALUATION: "Оценка стоимости",
};
export function StockControls({
  variantId,
  csrfToken,
  title,
  onChanged,
}: {
  variantId: string;
  csrfToken: string;
  title?: string;
  onChanged?: () => void;
}) {
  const api = useAdminCatalogApi(csrfToken),
    [stock, setStock] = useState<Stock>(),
    [retry, setRetry] = useState(0);
  const [kind, setKind] = useState("RECEIPT"),
    [quantity, setQuantity] = useState(""),
    [reason, setReason] = useState(""),
    [confirm, setConfirm] = useState(false);
  const pending = useRef<{ payload: object } | null>(null);
  const load = async () =>
    setStock(
      await api.request<Stock>(
        `/api/v1/admin/shop/variants/${variantId}/stock`,
      ),
    );
  useEffect(() => {
    const abort = new AbortController();
    void api
      .request<Stock>(
        `/api/v1/admin/shop/variants/${variantId}/stock`,
        "GET",
        undefined,
        abort.signal,
      )
      .then((value) => {
        if (!abort.signal.aborted) {
          setStock(value);
          api.setError("");
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) api.setError(e.message);
      });
    return () => abort.abort();
  }, [variantId, retry, api.request]);
  const reset = () => {
    setConfirm(false);
    pending.current = null;
  };
  const delta = stock
    ? kind === "COUNT"
      ? Number(quantity) - stock.onHand
      : kind === "WRITE_OFF"
        ? -Number(quantity)
        : Number(quantity)
    : 0;
  return (
    <section
      aria-label={title ? `Остаток ${title}` : "Остаток"}
      className="app-panel space-y-4"
    >
      <h3>{title || "Остаток"}</h3>
      {api.error && (
        <p role="alert" className="text-danger">
          {api.error}
        </p>
      )}
      {api.notice && (
        <p role="status" className="text-success">
          {api.notice}
        </p>
      )}
      {!stock ? (
        <>
          <p>Загружаем остаток…</p>
          <button
            className={buttonClass}
            onClick={() => setRetry((v) => v + 1)}
          >
            Повторить загрузку
          </button>
        </>
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-2">
            <div>
              <dt>На складе</dt>
              <dd className="text-2xl">{stock.onHand}</dd>
            </div>
            <div>
              <dt>В заказах</dt>
              <dd className="text-2xl">{stock.reserved}</dd>
            </div>
            <div>
              <dt>Доступно</dt>
              <dd className="text-2xl">{stock.available}</dd>
            </div>
          </dl>
          {stock.buffer > 0 && (
            <p className="text-muted">
              Дополнительно отложено: {stock.buffer} шт.
            </p>
          )}
          {!stock.initialized ? (
            <p>
              Начальный остаток ещё не внесён. Сначала выполните проверенный
              перенос для этого варианта.
            </p>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!confirm) {
                  setConfirm(true);
                  return;
                }
                if (!pending.current)
                  pending.current = {
                    payload: {
                      operationKey: crypto.randomUUID(),
                      kind,
                      quantity: Number(quantity),
                      expectedOnHand: stock.onHand,
                      reason,
                      occurredAt: new Date().toISOString(),
                    },
                  };
                void api.mutate(async () => {
                  await api.request(
                    `/api/v1/admin/shop/variants/${variantId}/stock`,
                    "POST",
                    pending.current!.payload,
                  );
                  await load();
                  pending.current = null;
                  setQuantity("");
                  setReason("");
                  setConfirm(false);
                  api.setNotice(
                    "Остаток обновлён. Запись добавлена в историю.",
                  );
                  onChanged?.();
                });
              }}
            >
              <fieldset disabled={api.busy} className="space-y-3">
                <Field label="Действие со складом">
                  <select
                    disabled={pending.current !== null}
                    className={inputClass}
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value);
                      reset();
                    }}
                  >
                    <option value="RECEIPT">Добавить поступление</option>
                    <option value="WRITE_OFF">Списать</option>
                    <option value="COUNT">Пересчитать остаток</option>
                  </select>
                </Field>
                <Field
                  label={
                    kind === "COUNT"
                      ? "Фактически на складе, шт."
                      : "Количество, шт."
                  }
                >
                  <input
                    disabled={pending.current !== null}
                    className={inputClass}
                    inputMode="numeric"
                    type="number"
                    min={kind === "COUNT" ? 0 : 1}
                    max={1000000}
                    step="1"
                    required
                    value={quantity}
                    onChange={(e) => {
                      setQuantity(e.target.value);
                      reset();
                    }}
                  />
                </Field>
                <Field label="Причина">
                  <input
                    disabled={pending.current !== null}
                    className={inputClass}
                    required
                    maxLength={500}
                    value={reason}
                    placeholder={
                      kind === "RECEIPT"
                        ? "Например, поставка от 3 ноября"
                        : "Например, повреждение или пересчёт"
                    }
                    onChange={(e) => {
                      setReason(e.target.value);
                      reset();
                    }}
                  />
                </Field>
                {quantity !== "" && (
                  <p>
                    Было {stock.onHand} → станет {stock.onHand + delta} шт.
                    Изменение: {delta > 0 ? "+" : ""}
                    {delta}.
                  </p>
                )}
                {confirm && (
                  <p role="status" className="rounded-lg bg-warning-soft p-3">
                    Проверьте количество и причину. Подтверждение добавит запись
                    в историю склада.
                  </p>
                )}
                <button
                  className={`${buttonClass} ${confirm ? "app-button-primary" : ""}`}
                  disabled={
                    !quantity ||
                    delta === 0 ||
                    stock.onHand + delta < stock.reserved
                  }
                >
                  {api.busy
                    ? "Сохраняем…"
                    : confirm
                      ? "Подтвердить изменение"
                      : "Проверить изменение"}
                </button>
                {pending.current && api.error && (
                  <p>
                    Если ответ потерялся, повторите подтверждение: операция не
                    задвоится.
                  </p>
                )}
              </fieldset>
            </form>
          )}
          <details>
            <summary>История изменений</summary>
            <ol className="space-y-3">
              {stock.history.map((m) => (
                <li key={m.id} className="border-t border-hairline py-3">
                  <p>
                    {kinds[m.kind] || "Изменение"} · {m.delta > 0 ? "+" : ""}
                    {m.delta} шт. → {m.onHandAfter}
                  </p>
                  <p className="text-sm text-muted">
                    {new Date(m.occurredAt).toLocaleString("ru-BY")} · {m.actor}
                  </p>
                  <p>{m.reason}</p>
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </section>
  );
}
