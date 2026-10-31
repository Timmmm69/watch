"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AdminCatalogLayout, Field, Pagination, availabilityLabels, buttonClass, inputClass, useAdminCatalogApi, type PageData } from "./admin-catalog-common";

interface InventoryItem { variantId: string; productId: string; productTitle: string; sku: string; inventoryExternalKey: string;
  authority?: "native" | "external"; onHand?: number | null; freeValueMinor?: number | null;
  reservedKnownValueMinor?: number | null; reservedUnknownQuantity?: number | null;
  sourceQuantity: number | null; safetyBuffer: number; sourceStatus: string; availability: string; sellable: number; deficit: boolean;
  activeReservations: number; reconciliationPending: number; sourceVersion: string | null; lastSuccessfulSyncRunId: string | null; lastSuccessfulSyncAt: string | null; }
interface SyncRun { id: string; status: string; startedAt: string; finishedAt: string | null; itemsProcessed: number; itemsFailed: number;
  errorSummary: string | null; details: Record<string, unknown> | null; }

export function AdminInventoryScreen({ csrfToken }: { csrfToken: string }) {
  const api = useAdminCatalogApi(csrfToken);
  const [page, setPage] = useState(1), [runPage, setRunPage] = useState(1), [retry, setRetry] = useState(0);
  const [data, setData] = useState<PageData<InventoryItem>>();
  const [runs, setRuns] = useState<PageData<SyncRun>>();
  const native = data?.items.some(item => item.authority === "native") ?? false;
  useEffect(() => {
    const controller = new AbortController(); setData(undefined); setRuns(undefined); api.setError("");
    void Promise.all([
      api.request<PageData<InventoryItem>>(`/api/v1/admin/inventory?page=${page}&limit=20`, "GET", undefined, controller.signal),
      api.request<PageData<SyncRun>>(`/api/v1/admin/inventory/sync-runs?page=${runPage}&limit=10`, "GET", undefined, controller.signal)
    ]).then(([items, history]) => { if (!controller.signal.aborted) { setData(items); setRuns(history); } })
      .catch(cause => { if (!controller.signal.aborted) api.setError(cause.message); });
    return () => controller.abort();
  }, [page, runPage, retry, api.request]);
  const refresh = async () => {
    const [items, history] = await Promise.all([
      api.request<PageData<InventoryItem>>(`/api/v1/admin/inventory?page=${page}&limit=20`),
      api.request<PageData<SyncRun>>(`/api/v1/admin/inventory/sync-runs?page=${runPage}&limit=10`)
    ]); setData(items); setRuns(history);
  };
  return <AdminCatalogLayout title="Склад">
    <p>{native ? "Внутренний склад. Остатки изменяются поступлениями, резервами и корректировками с причиной." : "Внешний источник остатков. Количество источника доступно только для чтения."}</p>
    {api.error && <p role="alert" className="text-warning">{api.error}</p>}{api.notice && <p role="status">{api.notice}</p>}
    {api.denied ? <p>У вас нет доступа к управлению складом.</p> : <>
      <div className="flex flex-wrap gap-4"><button className={buttonClass} disabled={api.busy} onClick={() => setRetry(n => n + 1)}>Обновить</button>
        {!native && <button className={buttonClass} disabled={api.busy || !data} onClick={() => void api.mutate(async () => {
          const result = await api.request<SyncRun>("/api/v1/admin/inventory/sync", "POST", {});
          await refresh(); api.setNotice(`Синхронизация ${result.id}: ${result.status}`);
        }, "Синхронизировать остатки с Google Sheet сейчас?")}>Синхронизировать сейчас</button>}</div>
      {api.busy && <p role="status">Сохраняем изменения…</p>}
      {!data && !api.error && <p role="status">Загружаем остатки…</p>}
      {data && <fieldset disabled={api.busy} className="space-y-4">
        {data.total === 0 && <p>Товаров на складе пока нет.</p>}<ul className="space-y-3">{data.items.map(item => <li key={item.variantId} className="space-y-2 rounded-xl bg-surface-muted p-4">
          <Link className="underline" href={`/admin/products/${item.productId}`}>{item.productTitle} · {item.sku}</Link><p>ID варианта: {item.variantId}</p>
          {!native && <p>Код во внешнем источнике: {item.inventoryExternalKey} · Источник: {item.sourceStatus}</p>}
          <p>Доступность: {availabilityLabels[item.availability] ?? item.availability}</p>
          <p>{native ? "Физический остаток" : "Остаток источника"}: {(native ? item.onHand : item.sourceQuantity) ?? "неизвестен"} · Резерв безопасности: {item.safetyBuffer} · Доступно: {item.sellable}</p>
          {native && <p>Стоимость свободного остатка: {item.freeValueMinor == null ? "Нет данных" : `${(item.freeValueMinor / 100).toFixed(2)} BYN`} · Стоимость резервов известна на {((item.reservedKnownValueMinor ?? 0) / 100).toFixed(2)} BYN · Единиц в резерве с неизвестной стоимостью: {item.reservedUnknownQuantity ?? 0}</p>}
          <p>Резервы: {item.activeReservations} · Ожидают сверки: {item.reconciliationPending}</p>
          {item.reconciliationPending > 0 && <Link className="underline" href="/admin/orders?reconciliationPending=true">Посмотреть заказы для сверки</Link>}
          {item.deficit && <p className="text-warning">Дефицит</p>}
          {!native && <><p>Версия источника: {item.sourceVersion ?? "неизвестна"}</p><p>Последний успешный запуск: {item.lastSuccessfulSyncRunId ?? "отсутствует"}</p>
          <p>Остатки обновлены: {item.lastSuccessfulSyncAt ? new Date(item.lastSuccessfulSyncAt).toLocaleString("ru-BY") : "отсутствует"}</p></>}
          <form aria-label={`Резерв ${item.sku}`} key={`${item.variantId}:${item.safetyBuffer}`} className="space-y-2" onSubmit={event => {
            event.preventDefault(); const safetyBuffer = Number(new FormData(event.currentTarget).get("safetyBuffer"));
            void api.mutate(async () => { await api.request(`/api/v1/admin/variants/${item.variantId}`, "PATCH", { safetyBuffer }); await refresh(); api.setNotice("Страховой резерв сохранён."); }, `Изменить страховой резерв ${item.sku} на ${safetyBuffer}?`);
          }}><Field label="Новый резерв безопасности"><input className={inputClass} name="safetyBuffer" type="number" min={0} step={1} required defaultValue={item.safetyBuffer} /></Field>
            <button className={buttonClass}>Сохранить резерв безопасности</button></form>
        </li>)}</ul><Pagination data={data} onPage={setPage} />
      </fieldset>}
      {runs && (!native || runs.items.length > 0) && <section className="space-y-3" aria-label="История синхронизаций"><h2 className="text-xl">История синхронизаций{native ? " до перехода на внутренний склад" : ""}</h2>
        {runs.items.length === 0 && <p>Обновлений остатков пока нет.</p>}<ul>{runs.items.map(run => <li key={run.id} className="my-3 rounded-xl bg-surface-muted p-4">
          <p>{run.id} · {run.status}</p><p>Начало: {new Date(run.startedAt).toLocaleString("ru-BY")} · Конец: {run.finishedAt ? new Date(run.finishedAt).toLocaleString("ru-BY") : "выполняется"}</p>
          <p>Проверено позиций: {run.itemsProcessed} · Ошибок: {run.itemsFailed}</p>{run.errorSummary && <p className="text-warning">{run.errorSummary}</p>}
          {run.details && <pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(run.details, null, 2)}</pre>}
        </li>)}</ul><fieldset disabled={api.busy}><Pagination data={runs} onPage={setRunPage} /></fieldset>
      </section>}
    </>}
  </AdminCatalogLayout>;
}
