"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AdminCatalogLayout, Field, Pagination, availabilityLabels, buttonClass, inputClass, useAdminCatalogApi, type PageData } from "./admin-catalog-common";

interface InventoryItem { variantId: string; productId: string; productTitle: string; sku: string; inventoryExternalKey: string;
  sourceQuantity: number | null; safetyBuffer: number; sourceStatus: string; availability: string; sellable: number; deficit: boolean;
  activeReservations: number; reconciliationPending: number; sourceVersion: string | null; lastSuccessfulSyncRunId: string | null; lastSuccessfulSyncAt: string | null; }
interface SyncRun { id: string; status: string; startedAt: string; finishedAt: string | null; itemsProcessed: number; itemsFailed: number;
  errorSummary: string | null; details: Record<string, unknown> | null; }

export function AdminInventoryScreen({ csrfToken }: { csrfToken: string }) {
  const api = useAdminCatalogApi(csrfToken);
  const [page, setPage] = useState(1), [runPage, setRunPage] = useState(1), [retry, setRetry] = useState(0);
  const [data, setData] = useState<PageData<InventoryItem>>();
  const [runs, setRuns] = useState<PageData<SyncRun>>();
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
  return <AdminCatalogLayout title="Инвентарь">
    <p>Google Sheet — источник остатков. Количество источника доступно только для чтения.</p>
    {api.error && <p role="alert" className="text-amber-300">{api.error}</p>}{api.notice && <p role="status">{api.notice}</p>}
    {api.denied ? <p>Управление инвентарём недоступно.</p> : <>
      <div className="flex flex-wrap gap-4"><button className={buttonClass} disabled={api.busy} onClick={() => setRetry(n => n + 1)}>Обновить</button>
        <button className={buttonClass} disabled={api.busy} onClick={() => void api.mutate(async () => {
          const result = await api.request<SyncRun>("/api/v1/admin/inventory/sync", "POST", {});
          await refresh(); api.setNotice(`Синхронизация ${result.id}: ${result.status}`);
        }, "Синхронизировать остатки с Google Sheet сейчас?")}>Синхронизировать сейчас</button></div>
      {api.busy && <p role="status">Выполнение запроса… Дождитесь результата.</p>}
      {!data && !api.error && <p role="status">Загрузка инвентаря…</p>}
      {data && <fieldset disabled={api.busy} className="space-y-4">
        {data.total === 0 && <p>Инвентарь пуст</p>}<ul className="space-y-3">{data.items.map(item => <li key={item.variantId} className="space-y-2 rounded bg-slate-900 p-4">
          <Link className="underline" href={`/admin/products/${item.productId}`}>{item.productTitle} · {item.sku}</Link><p>Вариант: {item.variantId}</p>
          <p>Внешний ключ: {item.inventoryExternalKey}</p><p>Источник: {item.sourceStatus} · Доступность: {availabilityLabels[item.availability] ?? item.availability}</p>
          <p>Остаток источника: {item.sourceQuantity ?? "неизвестен"} · Страховой резерв: {item.safetyBuffer} · Доступно: {item.sellable}</p>
          <p>Резервы: {item.activeReservations} · Ожидает сверки: {item.reconciliationPending}</p>
          {item.reconciliationPending > 0 && <Link className="underline" href="/admin/orders?reconciliationPending=true">Открыть заказы на сверку</Link>}
          {item.deficit && <p className="text-amber-300">Дефицит</p>}
          <p>Версия источника: {item.sourceVersion ?? "неизвестна"}</p><p>Успешный SyncRun: {item.lastSuccessfulSyncRunId ?? "отсутствует"}</p>
          <p>Последняя успешная синхронизация: {item.lastSuccessfulSyncAt ? new Date(item.lastSuccessfulSyncAt).toLocaleString("ru-BY") : "отсутствует"}</p>
          <form aria-label={`Резерв ${item.sku}`} key={`${item.variantId}:${item.safetyBuffer}`} className="space-y-2" onSubmit={event => {
            event.preventDefault(); const safetyBuffer = Number(new FormData(event.currentTarget).get("safetyBuffer"));
            void api.mutate(async () => { await api.request(`/api/v1/admin/variants/${item.variantId}`, "PATCH", { safetyBuffer }); await refresh(); api.setNotice("Страховой резерв сохранён."); }, `Изменить страховой резерв ${item.sku} на ${safetyBuffer}?`);
          }}><Field label="Новый страховой резерв"><input className={inputClass} name="safetyBuffer" type="number" min={0} step={1} required defaultValue={item.safetyBuffer} /></Field>
            <button className={buttonClass}>Сохранить резерв</button></form>
        </li>)}</ul><Pagination data={data} onPage={setPage} />
      </fieldset>}
      {runs && <section className="space-y-3" aria-label="История синхронизаций"><h2 className="text-xl">История синхронизаций</h2>
        {runs.items.length === 0 && <p>Синхронизаций пока нет</p>}<ul>{runs.items.map(run => <li key={run.id} className="my-3 rounded bg-slate-900 p-4">
          <p>{run.id} · {run.status}</p><p>Начало: {new Date(run.startedAt).toLocaleString("ru-BY")} · Конец: {run.finishedAt ? new Date(run.finishedAt).toLocaleString("ru-BY") : "выполняется"}</p>
          <p>Обработано: {run.itemsProcessed} · Ошибок: {run.itemsFailed}</p>{run.errorSummary && <p className="text-amber-300">{run.errorSummary}</p>}
          {run.details && <pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(run.details, null, 2)}</pre>}
        </li>)}</ul><fieldset disabled={api.busy}><Pagination data={runs} onPage={setRunPage} /></fieldset>
      </section>}
    </>}
  </AdminCatalogLayout>;
}
