"use client";
import { useEffect, useRef, useState } from "react";
import { MAX_IMAGE_UPLOAD_BYTES } from "@watch/contracts";
import {
  buttonClass,
  type Product,
  type Asset,
  useAdminCatalogApi,
} from "./admin-catalog-common";
export function ProductPhotos({
  product,
  csrfToken,
  refresh,
  onPendingChange,
}: {
  product: Product;
  csrfToken: string;
  refresh: () => Promise<void>;
  onPendingChange: (pending: boolean) => void;
}) {
  const api = useAdminCatalogApi(csrfToken);
  const [queue, setQueue] = useState<
    { key: string; file: File; state: string }[]
  >([]);
  useEffect(() => {
    onPendingChange(queue.some((item) => item.state !== "Загружено"));
  }, [queue, onPendingChange]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const gallery = product.assets
    .filter(
      (a) =>
        a.type === "IMAGE" &&
        a.purpose === "STOREFRONT" &&
        a.status === "ACTIVE",
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const update = (key: string, state: string) =>
    setQueue((q) => q.map((i) => (i.key === key ? { ...i, state } : i)));
  const upload = () =>
    void api.mutate(async () => {
      for (const item of queueRef.current) {
        if (item.state === "Загружено") continue;
        if (
          !["image/jpeg", "image/png", "image/webp"].includes(item.file.type) ||
          item.file.size > MAX_IMAGE_UPLOAD_BYTES ||
          !item.file.size
        ) {
          update(item.key, "Нужен JPEG, PNG или WebP до 10 МБ");
          continue;
        }
        update(item.key, "Загружаем…");
        try {
          const form = new FormData();
          form.set("purpose", "STOREFRONT");
          form.set("file", item.file);
          await api.request(
            `/api/v1/admin/products/${product.id}/assets/media`,
            "POST",
            form,
            undefined,
            item.key,
          );
          update(item.key, "Загружено");
        } catch (error) {
          update(
            item.key,
            error instanceof Error ? error.message : "Не удалось загрузить",
          );
        }
      }
      await refresh();
    });
  const first = async (asset: Asset) => {
    await api.request(`/api/v1/admin/assets/${asset.id}`, "PATCH", {
      sortOrder: Math.min(0, ...gallery.map((a) => a.sortOrder)) - 1,
    });
    await refresh();
  };
  const after = async (asset: Asset) => {
    await api.request(`/api/v1/admin/assets/${asset.id}`, "PATCH", {
      sortOrder: Math.max(0, ...gallery.map((a) => a.sortOrder)) + 1,
    });
    await refresh();
  };
  return (
    <section className="app-panel space-y-4" aria-label="Фотографии">
      <h2 className="text-xl">Фотографии</h2>
      <p className="text-muted">
        Первое фото — обложка. JPEG, PNG или WebP, до 10 МБ каждое.
      </p>
      {api.error && (
        <p role="alert" className="text-danger">
          {api.error}
        </p>
      )}
      <label className="block space-y-2">
        <span>Добавить фотографии</span>
        <input
          className="w-full"
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          disabled={api.busy}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            setQueue((q) => [
              ...q,
              ...files.map((file) => ({
                key: crypto.randomUUID(),
                file,
                state: "Готово к загрузке",
              })),
            ]);
            e.target.value = "";
          }}
        />
      </label>
      {queue.length > 0 && (
        <>
          <ul className="space-y-2" aria-live="polite">
            {queue.map((item) => (
              <li key={item.key} className="break-words text-sm">
                {item.file.name}: {item.state}
                {item.state !== "Загружено" && (
                  <button
                    type="button"
                    className="app-button ml-2"
                    disabled={api.busy}
                    onClick={() =>
                      setQueue((q) => q.filter((v) => v.key !== item.key))
                    }
                  >
                    Убрать из очереди
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={buttonClass}
            disabled={api.busy || queue.every((i) => i.state === "Загружено")}
            onClick={upload}
          >
            {api.busy ? "Загружаем…" : "Загрузить выбранные фото"}
          </button>
        </>
      )}
      {gallery.length === 0 && (
        <p className="rounded-lg bg-surface-muted p-5 text-muted">
          Добавьте фото, чтобы покупатель увидел часы.
        </p>
      )}
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {gallery.map((asset, i) => (
          <li
            key={asset.id}
            className="space-y-2 rounded-xl border border-hairline p-3"
          >
            {asset.mediaUrl && (
              <img
                className="aspect-square w-full rounded-lg bg-surface-muted object-cover"
                src={asset.mediaUrl}
                alt={`${product.title}, фото ${i + 1}`}
              />
            )}
            <p className="text-sm text-muted">
              {i === 0 ? "Обложка" : `Фото ${i + 1}`}
              {asset.variantId ? " · Фото варианта" : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              {i > 0 && (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={api.busy}
                  onClick={() => void api.mutate(() => first(asset))}
                >
                  На обложку
                </button>
              )}
              {i < gallery.length - 1 && (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={api.busy}
                  onClick={() => void api.mutate(() => after(asset))}
                >
                  В конец
                </button>
              )}
              <button
                type="button"
                className={buttonClass}
                disabled={api.busy}
                onClick={() =>
                  void api.mutate(async () => {
                    await api.request(
                      `/api/v1/admin/assets/${asset.id}`,
                      "PATCH",
                      { status: "ARCHIVED" },
                    );
                    await refresh();
                  }, "Убрать это фото из карточки?")
                }
              >
                Удалить фото
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
