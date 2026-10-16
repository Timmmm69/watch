import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import type { MultipartFile } from "@fastify/multipart";
import { Readable } from "node:stream";
import { CatalogService } from "../catalog/catalog.js";
import { AssetService, type ObjectStorage } from "../catalog/assets.js";
import { stageMedia } from "../catalog/media-upload.js";
import { inventoryTransaction, NativeInventoryError, NativeInventoryService, validateOperation, type InventoryOperation } from "./native.js";

export const INVENTORY_HEADERS = ["SKU", "Название / модель", "Вариант", "Количество, шт.", "Закупка всего, BYN",
  "Цена дропу за 1 шт., BYN", "Ссылка на фото", "Описание / характеристики", "Примечание / комплектация"];
export interface ImportRow {
  line: number; sku: string; title: string; variant: string; quantity: number; cost: number | null;
  dropshipPrice: number | null; photo: string; description: string; note: string;
}
export interface ImportIssue { line: number; sku: string; code: string }
export interface ImportPreview {
  digest: string; confirmation: string; rows: ImportRow[]; errors: ImportIssue[]; warnings: ImportIssue[];
  mappings: (string | null)[]; media: ({path: string; sha256: string; mime: string} | null)[];
  totals: {skus: number; units: number; knownCostMinor: string; unknownCostSkus: number};
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Fixed CSV/TSV export, including quoted commas/newlines and UTF-8 BOM. */
export function parseInventoryExport(source: string): string[][] {
  const text=source.replace(/^\uFEFF/,"");
  const first=text.split(/\r?\n/,1)[0] ?? "";
  const delimiter=first.includes("\t") ? "\t" : first.startsWith("SKU;") ? ";" : ",";
  const records: string[][]=[]; let row: string[]=[]; let field=""; let quoted=false; let closed=false;
  for (let i=0;i<text.length;i++) {
    const c=text[i]!;
    if (quoted) {
      if (c==='"') { if (text[i+1]==='"') {field+='"';i++;} else {quoted=false;closed=true;} }
      else field+=c;
    } else if (c===delimiter || c==='\n' || c==='\r') {
      row.push(field); field="";closed=false;
      if (c!==delimiter) { records.push(row);row=[];if(c==='\r' && text[i+1]==='\n')i++; }
    } else if(c==='"' && field==="" && !closed) quoted=true;
    else { if(closed || c==='"')throw new NativeInventoryError("INVALID_CSV_QUOTES");field+=c; }
  }
  if(quoted)throw new NativeInventoryError("INVALID_CSV_QUOTES");
  if(field!=="" || row.length || closed) {row.push(field);records.push(row);}
  return records;
}
export function parseMinor(value: string): number | null {
  if (!value) return null;
  // Google CSV exports may use localized, grouped decimal amounts.
  if (/^\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?$/.test(value)) value=value.replace(/[ \u00a0\u202f]/g,"");
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value)) throw new NativeInventoryError("INVALID_MONEY");
  const [whole, fraction=""] = value.replace(",",".").split(".");
  const amount=BigInt(whole!)*100n+BigInt(fraction.padEnd(2,"0"));
  if(amount>2147483647n)throw new NativeInventoryError("INVALID_MONEY");
  return Number(amount);
}

export class InitialInventoryImport {
  constructor(private readonly pool: Pool, private readonly storage?: ObjectStorage) {}

  async preview(cells: string[][], mediaDirectory?: string, client: Pick<PoolClient,"query">=this.pool): Promise<ImportPreview> {
    if(JSON.stringify(cells[0]?.map(v=>v.trim()))!==JSON.stringify(INVENTORY_HEADERS)) throw new NativeInventoryError("INVALID_HEADERS");
    if(cells.length>10001)throw new NativeInventoryError("IMPORT_LIMIT_10000_ROWS");
    const rows: ImportRow[]=[]; const errors: ImportIssue[]=[]; const warnings: ImportIssue[]=[];
    const seen=new Set<string>();
    for(const [index, cellsRow] of cells.slice(1).entries()) {
      if(cellsRow.every(c=>!c.trim()))continue;
      const [sku="",title="",variant="",rawQuantity="",rawCost="",rawPrice="",photo="",description="",note=""]=cellsRow.map(v=>v.trim());
      const line=index+2; const issue=(code:string)=>errors.push({line,sku,code});
      if(cellsRow.length>9)issue("EXTRA_COLUMNS");
      if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(sku))issue("INVALID_SKU");
      if(!title || title.length>200 || variant.length>500 || description.length>10000 || note.length>2000 || photo.length>2000)issue("INVALID_CARD_TEXT");
      if(seen.has(sku.toUpperCase()))issue("DUPLICATE_SKU"); seen.add(sku.toUpperCase());
      const quantity=/^\d+$/.test(rawQuantity)?Number(rawQuantity):NaN;
      if(!Number.isInteger(quantity) || quantity<0 || quantity>2147483647)issue("INVALID_QUANTITY");
      let cost: number|null=null;let dropshipPrice:number|null=null;
      try{cost=parseMinor(rawCost);}catch{issue("INVALID_PROCUREMENT_TOTAL");}
      try{dropshipPrice=parseMinor(rawPrice);if(dropshipPrice!==null && dropshipPrice>2000000000)issue("INVALID_DROPSHIP_PRICE");}catch{issue("INVALID_DROPSHIP_PRICE");}
      if(quantity===0) {if(cost!==null && cost!==0)issue("COST_WITH_ZERO_QUANTITY");cost=0;}
      rows.push({line,sku,title,variant,quantity,cost,dropshipPrice,photo,description,note});
    }
    if(!rows.length)errors.push({line:1,sku:"",code:"EMPTY_IMPORT"});
    const platform=(await client.query("SELECT platform_currency FROM platform_settings WHERE singleton_id=1")).rows[0];
    if(platform?.platform_currency!=="BYN")errors.push({line:1,sku:"",code:"BYN_CURRENCY_BOOTSTRAP_REQUIRED"});
    const suppliers=await client.query("SELECT id FROM suppliers WHERE status='ACTIVE'");
    if(suppliers.rowCount!==1)errors.push({line:1,sku:"",code:"SINGLE_ACTIVE_SUPPLIER_REQUIRED"});
    const mappings:(string|null)[]=[];const media:ImportPreview["media"]=[];
    const files=mediaDirectory ? await readdir(mediaDirectory) : [];
    for(const row of rows) {
      const matches=await client.query(`SELECT v.id,v.sku,v.inventory_external_key,p.title,p.status AS product_status,v.status,
        i.native_initialization_id,v.attributes,
        (SELECT count(*)::int FROM product_variants shared WHERE shared.product_id=p.id) AS variant_count
        FROM product_variants v JOIN products p ON p.id=v.product_id
        LEFT JOIN inventory_items i ON i.variant_id=v.id
        WHERE lower(trim(v.sku))=lower($1) OR lower(trim(v.inventory_external_key))=lower($1)`,[row.sku]);
      const match=matches.rows[0];
      if((matches.rowCount ?? 0)>1 || match && (match.sku!==row.sku || match.inventory_external_key!==row.sku || match.title!==row.title
        || (match.attributes?.variant ?? "")!==row.variant)) errors.push({line:row.line,sku:row.sku,code:"AMBIGUOUS_SKU_MAPPING"});
      if(match && (match.native_initialization_id || match.status!=="DRAFT" || match.product_status!=="DRAFT"))
        errors.push({line:row.line,sku:row.sku,code:"EXISTING_VARIANT_REQUIRES_RECONCILIATION"});
      mappings.push(match?.id ?? null);
      if(match?.variant_count>1)errors.push({line:row.line,sku:row.sku,code:"SHARED_PRODUCT_REQUIRES_RECONCILIATION"});
      const candidates=files.filter(f=>f.replace(/\.(jpg|jpeg|png|webp)$/i,"")===row.sku && /\.(jpg|jpeg|png|webp)$/i.test(f));
      if(candidates.length>1)errors.push({line:row.line,sku:row.sku,code:"AMBIGUOUS_MEDIA"});
      if(candidates.length===1) {
        const path=join(mediaDirectory!,candidates[0]!);
        const bytes=await readFile(path);
        const mime=/\.png$/i.test(path)?"image/png":/\.webp$/i.test(path)?"image/webp":"image/jpeg";
        try {
          const staged=await stageMedia({file:Readable.from(bytes),filename:candidates[0]!,mimetype:mime} as MultipartFile);
          await staged.cleanup();
          media.push({path,sha256:hash(bytes),mime});
        } catch {errors.push({line:row.line,sku:row.sku,code:"INVALID_MEDIA"});media.push(null);}
      } else {media.push(null);warnings.push({line:row.line,sku:row.sku,code:"PHOTO_NOT_STAGED_DRAFT_ONLY"});}
      if(row.cost===null)warnings.push({line:row.line,sku:row.sku,code:"PROCUREMENT_UNKNOWN"});
      if(row.dropshipPrice===null || !row.description)warnings.push({line:row.line,sku:row.sku,code:"INCOMPLETE_CARD_DRAFT_ONLY"});
    }
    const active=await client.query("SELECT 1 FROM inventory_reservations WHERE status='ACTIVE' AND economic_regime='LEGACY_FIXED' LIMIT 1");
    if(active.rowCount)errors.push({line:1,sku:"",code:"RECONCILE_LEGACY_RESERVATIONS"});
    const digest=hash(JSON.stringify(rows));
    const confirmation=hash(JSON.stringify({digest,mappings,media:media.map(m=>m?.sha256 ?? null)}));
    return {digest,confirmation,rows,errors,warnings,mappings,media,totals:{skus:rows.length,
      units:rows.reduce((s,r)=>s+(Number.isInteger(r.quantity)?r.quantity:0),0),
      knownCostMinor:rows.reduce((s,r)=>s+BigInt(r.cost ?? 0),0n).toString(),unknownCostSkus:rows.filter(r=>r.cost===null).length}};
  }

  async apply(cells:string[][], confirmation:string, op:InventoryOperation, mediaDirectory?:string):Promise<{initializationId:string;replayed:boolean}> {
    validateOperation(op);
    if(!/^[a-f0-9]{64}$/.test(confirmation))throw new NativeInventoryError("PREVIEW_CONFIRMATION_REQUIRED");
    const uploaded:string[]=[];
    const storage=this.storage;
    const tracked: ObjectStorage|undefined=storage ? {put:async (...args)=>{uploaded.push(args[0]);await storage.put(...args);},
      get:key=>storage.get(key),delete:key=>storage.delete(key)} : undefined;
    try {
      return await inventoryTransaction(this.pool,async client=>{
        const native=new NativeInventoryService(this.pool);
        // Serialize against legacy sync and other initializations before catalog locks.
        await client.query("SELECT pg_advisory_xact_lock(1463899203,1)");
        await client.query("SELECT pg_advisory_xact_lock(1463899203,2)");
        const preview=await this.preview(cells,mediaDirectory,client);
        const existing=(await client.query("SELECT id,source_reference FROM inventory_initializations WHERE operation_key=$1",[`initial:${confirmation}`])).rows[0];
        if(existing) {
          if(existing.source_reference!==`sha256:${preview.digest}`)throw new NativeInventoryError("IDEMPOTENCY_CONFLICT");
          return {initializationId:existing.id as string,replayed:true};
        }
        if(preview.errors.length)throw new NativeInventoryError(`IMPORT_VALIDATION_FAILED:${JSON.stringify(preview.errors)}`);
        // Lock mapped Products before Variants; lock/re-read mappings to detect edits after preview.
        const ids=preview.mappings.filter((id):id is string=>id!==null);
        await client.query(`SELECT id FROM categories WHERE id IN (SELECT category_id FROM product_categories
          WHERE product_id IN (SELECT product_id FROM product_variants WHERE id=ANY($1::uuid[]))) ORDER BY id FOR UPDATE`,[ids]);
        await native.lock(client,ids);
        const checked=await this.preview(cells,mediaDirectory,client);
        if(checked.errors.length || checked.confirmation!==confirmation)throw new NativeInventoryError("PREVIEW_CHANGED_RUN_AGAIN");
        if(checked.media.some(Boolean) && !tracked)throw new NativeInventoryError("MEDIA_STORAGE_REQUIRED");
        await native.selectAuthority(client,op);
        const catalog=new CatalogService(this.pool,"BYN",undefined,undefined,client);
        const assets=tracked ? new AssetService(this.pool,tracked,client):undefined;
        const entries:{variantId:string;quantity:number;cost:number|null}[]=[];
        for(const [index,row] of checked.rows.entries()) {
          let variantId=checked.mappings[index];let productId:string;
          if(variantId) {
            const existingCard=(await client.query(`SELECT p.id,p.specifications FROM products p JOIN product_variants v
              ON v.product_id=p.id WHERE v.id=$1`,[variantId])).rows[0];
            productId=existingCard.id;
            await catalog.updateProduct(op.actorUserId,productId,{description:row.description,
              specifications:{...existingCard.specifications,inventoryNote:row.note,inventoryPhotoReference:row.photo}});
          } else {
            const product=await catalog.createProduct(op.actorUserId,{title:row.title,description:row.description,
              specifications:{inventoryNote:row.note,inventoryPhotoReference:row.photo}});
            productId=product.id;
            const variant=await catalog.createVariant(op.actorUserId,productId,{sku:row.sku,attributes:row.variant?{variant:row.variant}:{},
              // Legacy required columns remain inert drafts; D is stored separately below.
              priceMinor:row.dropshipPrice ?? 0,partnerCommissionUnitMinor:0,inventoryExternalKey:row.sku});
            variantId=variant.id;
          }
          await client.query("UPDATE product_variants SET dropship_price_minor=$2 WHERE id=$1",[variantId,row.dropshipPrice]);
          const image=checked.media[index];
          if(image && assets) {
            const bytes=await readFile(image.path);
            if(hash(bytes)!==image.sha256)throw new NativeInventoryError("MEDIA_CHANGED_RUN_PREVIEW");
            const staged=await stageMedia({file:Readable.from(bytes),filename:image.path,mimetype:image.mime} as MultipartFile);
            try {await assets.createMedia(op.actorUserId,productId,{variantId,type:"IMAGE",purpose:"STOREFRONT",
              path:staged.path,mimeType:image.mime,sizeBytes:staged.sizeBytes});} finally {await staged.cleanup();}
          }
          entries.push({variantId,quantity:row.quantity,cost:row.cost});
        }
        const initializationId=randomUUID();
        await client.query(`INSERT INTO inventory_initializations(id,operation_key,source_reference,actor_user_id,reason,occurred_at)
          VALUES($1,$2,$3,$4,$5,$6)`,[initializationId,`initial:${confirmation}`,`sha256:${checked.digest}`,op.actorUserId,op.reason,op.occurredAt]);
        await native.initialize(client,{...op,operationKey:`initial:${confirmation}`},initializationId,entries);
        return {initializationId,replayed:false};
      });
    } catch(error) {if(storage)await Promise.all(uploaded.map(key=>storage.delete(key).catch(()=>undefined)));throw error;}
  }
}
