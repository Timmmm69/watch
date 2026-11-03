"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { StockControls } from "./admin-stock-controls";
import {
  AdminCatalogLayout,
  Pagination,
  buttonClass,
  useAdminCatalogApi,
  type PageData,
} from "./admin-catalog-common";
type Item = {
  variantId: string;
  productId: string;
  productTitle: string;
  sku: string;
};
export function AdminInventoryScreen({ csrfToken }: { csrfToken: string }) {
  const api = useAdminCatalogApi(csrfToken),
    [page, setPage] = useState(1),
    [retry, setRetry] = useState(0),
    [data, setData] = useState<PageData<Item>>();
  useEffect(() => {
    const abort = new AbortController();
    setData(undefined);
    void api
      .request<PageData<Item>>(
        `/api/v1/admin/inventory?page=${page}&limit=20`,
        "GET",
        undefined,
        abort.signal,
      )
      .then(setData)
      .catch((e) => {
        if (!abort.signal.aborted) api.setError(e.message);
      });
    return () => abort.abort();
  }, [page, retry, api.request]);
  return (
    <AdminCatalogLayout title="Склад">
      <p className="text-muted">
        На складе — физическое количество. В заказах — отложенное. Доступно —
        то, что можно заказать сейчас.
      </p>
      {api.error && (
        <p role="alert" className="text-danger">
          {api.error}
        </p>
      )}
      <button
        className={buttonClass}
        onClick={() => {
          api.setError("");
          setRetry((n) => n + 1);
        }}
      >
        Обновить
      </button>
      {!data && !api.error && <p role="status">Загружаем остатки…</p>}
      {data && (
        <>
          {!data.total && (
            <div className="app-panel">
              <p>
                Товаров пока нет. Добавьте часы в каталоге и укажите начальное
                количество.
              </p>
              <Link className={buttonClass} href="/admin/catalog">
                В каталог
              </Link>
            </div>
          )}
          <ul className="space-y-5">
            {data.items.map((item) => (
              <li key={`${item.variantId}:${retry}`} className="space-y-2">
                <Link
                  className="inline-flex min-h-11 items-center font-semibold"
                  href={`/admin/products/${item.productId}`}
                >
                  {item.productTitle} · {item.sku}
                </Link>
                <StockControls
                  variantId={item.variantId}
                  csrfToken={csrfToken}
                />
              </li>
            ))}
          </ul>
          <Pagination data={data} onPage={setPage} />
        </>
      )}
    </AdminCatalogLayout>
  );
}
