"use client";
import { useRef, useState } from "react";
import { rublesToMinor, minorToRubles } from "@watch/contracts";
import {
  Field,
  StatusOptions,
  variantStatusLabels,
  buttonClass,
  inputClass,
  jsonObject,
  type Variant,
  type Asset,
} from "./admin-catalog-common";
type FormActions = {
  mutate: (action: () => Promise<void>, confirmation?: string) => Promise<void>;
  save: (payload: object) => Promise<void>;
};
export function VariantForm({
  mutate,
  save,
}: FormActions & { variant?: Variant }) {
  const pending = useRef<{ signature: string; payload: object } | null>(null);
  return (
    <form
      aria-label="Новый вариант"
      className="app-panel space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const element = event.currentTarget,
          form = new FormData(element);
        void mutate(async () => {
          const fields = {
            attributes: form.get("label")
              ? { Вариант: String(form.get("label")) }
              : {},
            priceMinor: rublesToMinor(String(form.get("price"))),
            ...(form.get("seller")
              ? {
                  dropshipPriceMinor: rublesToMinor(String(form.get("seller"))),
                }
              : {}),
            partnerCommissionUnitMinor: rublesToMinor(
              String(form.get("commission")),
            ),
            supplierSettlementUnitMinor: form.get("settlement")
              ? rublesToMinor(String(form.get("settlement")))
              : null,
            sku: String(form.get("sku") || ""),
          };
          const signature = JSON.stringify(fields);
          if (!pending.current || pending.current.signature !== signature) {
            const sku =
              fields.sku ||
              `W-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
            pending.current = {
              signature,
              payload: {
                ...fields,
                sku,
                inventoryExternalKey: sku,
                operationKey: crypto.randomUUID(),
              },
            };
          }
          await save(pending.current.payload);
          pending.current = null;
          element.reset();
        });
      }}
    >
      <h3>Добавить вариант часов</h3>
      <p className="text-sm text-muted">
        Например, другой цвет циферблата. Начальный остаток — 0. Поступление
        можно внести ниже.
      </p>
      <Field label="Отличие варианта">
        <input
          className={inputClass}
          name="label"
          maxLength={200}
          placeholder="Например, синий циферблат"
        />
      </Field>
      <Field label="Цена, руб.">
        <input
          className={inputClass}
          name="price"
          inputMode="decimal"
          defaultValue="0,00"
          required
        />
      </Field>
      <Field label="Цена для продавца, руб.">
        <input className={inputClass} name="seller" inputMode="decimal" />
      </Field>
      <Field label="Реферальная комиссия, руб.">
        <input
          className={inputClass}
          name="commission"
          inputMode="decimal"
          defaultValue="0,00"
          required
        />
      </Field>
      <Field label="Расчёт с поставщиком, руб. (необязательно)">
        <input className={inputClass} name="settlement" inputMode="decimal" />
      </Field>
      <details>
        <summary>Свой артикул</summary>
        <Field label="Артикул варианта">
          <input
            className={inputClass}
            name="sku"
            maxLength={80}
            placeholder="Создадим автоматически"
          />
        </Field>
      </details>
      <button className={buttonClass}>Добавить вариант</button>
    </form>
  );
}
const assetTypeLabels: Record<string, string> = {
  IMAGE: "Фото",
  VIDEO: "Видео",
  TEXT: "Текст",
};
const assetPurposeLabels: Record<string, string> = {
  STOREFRONT: "Для магазина",
  PARTNER_CONTENT: "Для партнёров",
};

function PurposeOptions() {
  return (
    <>
      <option value="STOREFRONT">{assetPurposeLabels.STOREFRONT}</option>
      <option value="PARTNER_CONTENT">
        {assetPurposeLabels.PARTNER_CONTENT}
      </option>
    </>
  );
}
export function AssetCreateForm({
  variants,
  mutate,
  save,
}: Omit<FormActions, "save"> & {
  variants: Variant[];
  save: (type: string, form: FormData) => Promise<void>;
}) {
  const [type, setType] = useState("IMAGE");
  return (
    <form
      aria-label="Новый материал"
      className="app-panel space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const element = event.currentTarget;
        const form = new FormData(element);
        void mutate(async () => {
          await save(type, form);
          element.reset();
          setType("IMAGE");
        });
      }}
    >
      <Field label="Тип материала">
        <select
          className={inputClass}
          value={type}
          onChange={(event) => setType(event.target.value)}
        >
          <option value="IMAGE">Фото</option>
          <option value="VIDEO">Видео</option>
          <option value="TEXT">Текст</option>
        </select>
      </Field>
      <Field label="Назначение материала">
        <select className={inputClass} name="purpose">
          <PurposeOptions />
        </select>
      </Field>
      <Field label="Вариант материала">
        <select className={inputClass} name="variantId">
          <option value="">Для всех вариантов</option>
          {variants.map((v) => (
            <option key={v.id} value={v.id}>
              {v.sku}
            </option>
          ))}
        </select>
      </Field>
      {type === "TEXT" ? (
        <Field label="Текст материала">
          <textarea
            className={inputClass}
            name="text"
            required
            maxLength={10000}
          />
        </Field>
      ) : (
        <Field label="Файл материала">
          <input
            key={type}
            className={inputClass}
            name="file"
            type="file"
            required
            accept={
              type === "IMAGE"
                ? "image/jpeg,image/png,image/webp"
                : "video/mp4,video/webm"
            }
          />
        </Field>
      )}
      <button className={buttonClass}>Добавить материал</button>
    </form>
  );
}
export function AssetForm({
  asset,
  mutate,
  save,
}: FormActions & { asset: Asset }) {
  return (
    <form
      aria-label={`Материал ${asset.id}`}
      className="app-panel space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const purpose = String(form.get("purpose"));
        const status = String(form.get("status"));
        void mutate(
          async () => {
            await save({
              purpose,
              status,
              sortOrder: Number(form.get("sortOrder")),
              ...(asset.type === "TEXT"
                ? { text: String(form.get("text")) }
                : {}),
            });
          },
          purpose !== asset.purpose || status !== asset.status
            ? "Изменить назначение или статус материала? Сервер проверит условия публикации товара."
            : undefined,
        );
      }}
    >
      <h3>
        {assetTypeLabels[asset.type] ?? "Тип уточняется"} ·{" "}
        {assetPurposeLabels[asset.purpose] ?? "Назначение уточняется"} ·{" "}
        {variantStatusLabels[asset.status] ?? "Статус уточняется"}
      </h3>
      <p>
        Размер:{" "}
        {asset.sizeBytes == null
          ? "—"
          : `${Math.ceil(asset.sizeBytes / 1024)} КБ`}
      </p>
      {asset.mediaUrl && (
        <a
          className="underline"
          href={asset.mediaUrl}
          target="_blank"
          rel="noreferrer"
        >
          Открыть файл
        </a>
      )}
      {asset.type === "TEXT" && (
        <Field label="Текст материала">
          <textarea
            className={inputClass}
            name="text"
            required
            maxLength={10000}
            defaultValue={asset.text ?? ""}
          />
        </Field>
      )}
      <Field label="Назначение материала">
        <select
          className={inputClass}
          name="purpose"
          defaultValue={asset.purpose}
        >
          <PurposeOptions />
        </select>
      </Field>
      <Field label="Порядок материала">
        <input
          className={inputClass}
          name="sortOrder"
          type="number"
          required
          step={1}
          defaultValue={asset.sortOrder}
        />
      </Field>
      <Field label="Статус материала">
        <select
          className={inputClass}
          name="status"
          defaultValue={asset.status}
        >
          <StatusOptions current={asset.status} />
        </select>
      </Field>
      <button className={buttonClass}>Сохранить материал</button>
    </form>
  );
}
