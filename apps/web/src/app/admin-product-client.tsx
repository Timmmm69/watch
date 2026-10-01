"use client";

import { useEffect, useState, type FormEvent } from "react";
import { MAX_IMAGE_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_BYTES } from "@watch/contracts";
import { AdminCatalogLayout, Field, StatusOptions, buttonClass, inputClass, jsonObject, readCategories,
  useAdminCatalogApi, type Asset, type Category, type Product, type Variant } from "./admin-catalog-common";

export function AdminProductScreen({ csrfToken, productId }: { csrfToken: string; productId: string }) {
  const api = useAdminCatalogApi(csrfToken);
  const [product, setProduct] = useState<Product>();
  const [categories, setCategories] = useState<Category[]>([]);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setProduct(undefined); api.setError("");
    void Promise.all([api.request<Product>(`/api/v1/admin/products/${encodeURIComponent(productId)}`, "GET", undefined, controller.signal), readCategories(api.request, controller.signal)])
      .then(([p, c]) => { if (!controller.signal.aborted) { setProduct(p); setCategories(c); } })
      .catch(cause => { if (!controller.signal.aborted) api.setError(cause.message); });
    return () => controller.abort();
  }, [productId, retry, api.request]);
  const refresh = async () => { setProduct(await api.request<Product>(`/api/v1/admin/products/${encodeURIComponent(productId)}`)); };
  const saveCore = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const status = String(form.get("status"));
    void api.mutate(async () => {
      await api.request(`/api/v1/admin/products/${encodeURIComponent(productId)}`, "PATCH", {
        title: String(form.get("title")), description: String(form.get("description")), brand: String(form.get("brand")) || null,
        specifications: jsonObject(form.get("specifications")), categoryIds: form.getAll("categoryIds").map(String), status
      }); await refresh(); api.setNotice("Товар сохранён.");
    }, status !== product?.status ? `Изменить статус товара на ${status}? Сервер проверит условия публикации.` : undefined);
  };
  return <AdminCatalogLayout title={product ? product.title : "Товар"} back="/admin/catalog">
    {api.error && <p role="alert" className="text-amber-300">{api.error}</p>}{api.notice && <p role="status">{api.notice}</p>}
    {api.denied ? <p>Редактирование недоступно.</p> : <>
      <button className={buttonClass} disabled={api.busy} onClick={() => setRetry(n => n + 1)}>Обновить</button>
      {!product && !api.error && <p role="status">Загрузка товара…</p>}
      {product && <fieldset disabled={api.busy} className="space-y-5">
        <p>ACTIVE требует активную категорию, активный корректный вариант и активное изображение витрины. Удаление последнего обязательного элемента проверяется сервером.</p>
        <form key={product.updatedAt} aria-label="Редактирование товара" className="space-y-3 rounded bg-slate-900 p-4" onSubmit={saveCore}>
          <Field label="Название товара"><input className={inputClass} name="title" required maxLength={200} defaultValue={product.title} /></Field>
          <Field label="Slug товара"><input className={inputClass} readOnly value={product.slug} /></Field><p>Slug создаётся сервером и не изменяется существующим API.</p>
          <Field label="Описание"><textarea className={inputClass} name="description" defaultValue={product.description} /></Field>
          <Field label="Бренд"><input className={inputClass} name="brand" maxLength={120} defaultValue={product.brand ?? ""} /></Field>
          <Field label="Характеристики (JSON)"><textarea className={inputClass} name="specifications" defaultValue={JSON.stringify(product.specifications, null, 2)} /></Field>
          <fieldset className="space-y-2"><legend>Категории товара</legend>{categories.length === 0 && <p>Сначала создайте категорию в каталоге.</p>}
            {categories.map(category => <label key={category.id} className="block"><input type="checkbox" name="categoryIds" value={category.id}
              defaultChecked={product.categories.some(c => c.id === category.id)} /> {category.name} · {category.status}</label>)}
          </fieldset>
          <Field label="Статус товара"><select className={inputClass} name="status" defaultValue={product.status}><StatusOptions current={product.status} /></select></Field>
          <button className={buttonClass}>Сохранить товар</button>
        </form>
        <section className="space-y-4" aria-label="Варианты"><h2 className="text-xl">Варианты</h2>
          <p>Денежные значения — целые числа в минимальных единицах валюты (100 = 1). SKU после создания не изменяется.</p>
          {product.variants.length === 0 && <p>Вариантов нет</p>}
          {product.variants.map(variant => <VariantForm key={`${variant.id}:${variant.updatedAt}:${variant.inventory?.safetyBuffer}`} variant={variant} mutate={api.mutate}
            save={async payload => { await api.request(`/api/v1/admin/variants/${variant.id}`, "PATCH", payload); await refresh(); api.setNotice("Вариант сохранён."); }} />)}
          <VariantForm mutate={api.mutate} save={async payload => {
            await api.request(`/api/v1/admin/products/${product.id}/variants`, "POST", payload); await refresh(); api.setNotice("Вариант DRAFT создан. Настройте статус и резерв.");
          }} />
        </section>
        <section aria-label="Материалы" className="space-y-4"><h2 className="text-xl">Материалы</h2>
          <p>IMAGE: JPEG/PNG/WebP до 10 MiB. VIDEO: MP4/WebM до 50 MiB. Остатки поступают только из Google Sheet.</p>
          <AssetCreateForm variants={product.variants} mutate={api.mutate} save={async (type, form) => {
            if (type === "TEXT") {
              await api.request(`/api/v1/admin/products/${product.id}/assets/text`, "POST", {
                text: String(form.get("text")), purpose: String(form.get("purpose")), variantId: String(form.get("variantId")) || null
              });
            } else {
              const file = form.get("file");
              if (!(file instanceof File) || !file.size) throw new Error("Выберите файл.");
              const allowed = type === "IMAGE" ? ["image/jpeg", "image/png", "image/webp"] : ["video/mp4", "video/webm"];
              const limit = type === "IMAGE" ? MAX_IMAGE_UPLOAD_BYTES : MAX_VIDEO_UPLOAD_BYTES;
              if (!allowed.includes(file.type) || file.size > limit) throw new Error(`Недопустимый формат или размер. ${type}: максимум ${limit / 1024 / 1024} MiB.`);
              const upload = new FormData(); upload.set("purpose", String(form.get("purpose")));
              if (form.get("variantId")) upload.set("variantId", String(form.get("variantId")));
              upload.set("file", file);
              await api.request(`/api/v1/admin/products/${product.id}/assets/media`, "POST", upload);
            }
            await refresh(); api.setNotice("Материал добавлен.");
          }} />
          {product.assets.length === 0 && <p>Материалов нет</p>}
          {product.assets.map(asset => <AssetForm key={`${asset.id}:${asset.sortOrder}:${asset.purpose}:${asset.status}:${asset.text}`} asset={asset} mutate={api.mutate}
            save={async payload => { await api.request(`/api/v1/admin/assets/${asset.id}`, "PATCH", payload); await refresh(); api.setNotice("Материал сохранён."); }} />)}
        </section>
      </fieldset>}{api.busy && <p role="status">Сохранение…</p>}
    </>}
  </AdminCatalogLayout>;
}

type FormActions = { mutate: (action: () => Promise<void>, confirmation?: string) => Promise<void>; save: (payload: object) => Promise<void> };
function VariantForm({ variant, mutate, save }: FormActions & { variant?: Variant }) {
  return <form aria-label={variant ? `Вариант ${variant.sku}` : "Новый вариант"} className="space-y-3 rounded border border-slate-700 p-4" onSubmit={event => {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); const status = String(form.get("status"));
    void mutate(async () => {
      await save({ ...(variant ? { status, safetyBuffer: Number(form.get("safetyBuffer")) } : { sku: String(form.get("sku")) }),
        attributes: jsonObject(form.get("attributes")), priceMinor: Number(form.get("priceMinor")),
        partnerCommissionUnitMinor: Number(form.get("commission")), supplierSettlementUnitMinor: form.get("settlement") === "" ? null : Number(form.get("settlement")),
        inventoryExternalKey: String(form.get("externalKey")) });
      if (!variant) element.reset();
    }, variant && (status !== variant.status || String(form.get("externalKey")) !== variant.inventoryExternalKey)
      ? "Изменить статус или внешний ключ варианта? Изменение ключа сбрасывает снимок остатков и проверяется сервером." : undefined);
  }}>
    <h3>{variant ? `${variant.sku} · ${variant.status} · ${variant.currency}` : "Новый вариант DRAFT"}</h3>
    <Field label="SKU"><input className={inputClass} name="sku" required maxLength={100} readOnly={!!variant} defaultValue={variant?.sku} /></Field>
    <Field label="Атрибуты (JSON)"><textarea className={inputClass} name="attributes" defaultValue={JSON.stringify(variant?.attributes ?? {}, null, 2)} /></Field>
    <Field label="Цена (minor)"><input className={inputClass} name="priceMinor" type="number" min={0} max={2147483647} step={1} required defaultValue={variant?.priceMinor ?? 0} /></Field>
    <Field label="Комиссия (minor)"><input className={inputClass} name="commission" type="number" min={0} max={2147483647} step={1} required defaultValue={variant?.partnerCommissionUnitMinor ?? 0} /></Field>
    <Field label="Расчёт с поставщиком (minor, необязательно)"><input className={inputClass} name="settlement" type="number" min={0} max={2147483647} step={1} defaultValue={variant?.supplierSettlementUnitMinor ?? ""} /></Field>
    <Field label="Внешний ключ остатков"><input className={inputClass} name="externalKey" required maxLength={200} defaultValue={variant?.inventoryExternalKey} /></Field>
    {variant && <><Field label="Страховой резерв"><input className={inputClass} name="safetyBuffer" type="number" required min={0} step={1} defaultValue={variant.inventory?.safetyBuffer ?? 0} /></Field>
      <Field label="Статус варианта"><select className={inputClass} name="status" defaultValue={variant.status}><StatusOptions current={variant.status} /></select></Field></>}
    <button className={buttonClass}>{variant ? "Сохранить вариант" : "Создать вариант"}</button>
  </form>;
}
function PurposeOptions() { return <><option>STOREFRONT</option><option>PARTNER_CONTENT</option></>; }
function AssetCreateForm({ variants, mutate, save }: Omit<FormActions, "save"> & { variants: Variant[]; save: (type: string, form: FormData) => Promise<void> }) {
  const [type, setType] = useState("IMAGE");
  return <form aria-label="Новый материал" className="space-y-3 rounded border border-slate-700 p-4" onSubmit={event => {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element);
    void mutate(async () => { await save(type, form); element.reset(); setType("IMAGE"); });
  }}>
    <Field label="Тип материала"><select className={inputClass} value={type} onChange={event => setType(event.target.value)}><option>IMAGE</option><option>VIDEO</option><option>TEXT</option></select></Field>
    <Field label="Назначение материала"><select className={inputClass} name="purpose"><PurposeOptions /></select></Field>
    <Field label="Вариант материала"><select className={inputClass} name="variantId"><option value="">Весь товар</option>{variants.map(v => <option key={v.id} value={v.id}>{v.sku}</option>)}</select></Field>
    {type === "TEXT" ? <Field label="Текст материала"><textarea className={inputClass} name="text" required maxLength={10000} /></Field>
      : <Field label="Файл материала"><input key={type} className={inputClass} name="file" type="file" required accept={type === "IMAGE" ? "image/jpeg,image/png,image/webp" : "video/mp4,video/webm"} /></Field>}
    <button className={buttonClass}>Добавить материал</button>
  </form>;
}
function AssetForm({ asset, mutate, save }: FormActions & { asset: Asset }) {
  return <form aria-label={`Материал ${asset.id}`} className="space-y-3 rounded border border-slate-700 p-4" onSubmit={event => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const purpose = String(form.get("purpose")); const status = String(form.get("status"));
    void mutate(async () => { await save({ purpose, status, sortOrder: Number(form.get("sortOrder")), ...(asset.type === "TEXT" ? { text: String(form.get("text")) } : {}) }); },
      purpose !== asset.purpose || status !== asset.status ? "Изменить назначение или статус материала? Сервер проверит условия публикации товара." : undefined);
  }}>
    <h3>{asset.type} · {asset.purpose} · {asset.status}</h3><p>ID: {asset.id} · Вариант: {asset.variantId ?? "весь товар"} · Размер: {asset.sizeBytes ?? "—"}</p>
    {asset.mediaUrl && <a className="underline" href={asset.mediaUrl} target="_blank" rel="noreferrer">Открыть файл</a>}
    {asset.type === "TEXT" && <Field label="Текст материала"><textarea className={inputClass} name="text" required maxLength={10000} defaultValue={asset.text ?? ""} /></Field>}
    <Field label="Назначение материала"><select className={inputClass} name="purpose" defaultValue={asset.purpose}><PurposeOptions /></select></Field>
    <Field label="Порядок материала"><input className={inputClass} name="sortOrder" type="number" required step={1} defaultValue={asset.sortOrder} /></Field>
    <Field label="Статус материала"><select className={inputClass} name="status" defaultValue={asset.status}><StatusOptions current={asset.status} /></select></Field>
    <button className={buttonClass}>Сохранить материал</button>
  </form>;
}
