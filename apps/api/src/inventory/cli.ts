import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { GoogleAuth } from "google-auth-library";
import { createDatabasePool, checkDatabaseReady } from "@watch/db";
import { parseGoogleServiceAccount, parseAdminIds } from "@watch/config";
import { S3ObjectStorage } from "../catalog/assets.js";
import { InitialInventoryImport, parseInventoryExport, parseMinor } from "./initial-import.js";
import { assertInventoryMode, NativeInventoryService, type InventoryOperation } from "./native.js";

config({path:fileURLToPath(new URL("../../../../.env",import.meta.url)),quiet:true});
const [command,...argv]=process.argv.slice(2);
const args:Record<string,string>={};
try {
  for(let i=0;i<argv.length;i+=2) {
    const key=argv[i]; const value=argv[i+1];
    if(!key?.startsWith("--") || !value || value.startsWith("--") || args[key.slice(2)]!==undefined)throw new Error("Expected --name value pairs");
    args[key.slice(2)]=value;
  }
  const allowed=["file","google","media-dir","confirm","actor","reason","at","key","sku","quantity","cost"];
  if(Object.keys(args).some(key=>!allowed.includes(key)))throw new Error("Unknown option");
  if(process.env.INVENTORY_PROVIDER!=="native")throw new Error("Set INVENTORY_PROVIDER=native explicitly");
  if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required");
  const pool=createDatabasePool(process.env.DATABASE_URL);
  try {
    await checkDatabaseReady(pool);
    await assertInventoryMode(pool,"native",false);
    let cells:string[][]|undefined;
    if(command==="preview" || command==="apply") {
      if(Boolean(args.file)===Boolean(args.google))throw new Error("Choose --file path or --google true");
      if(args.file)cells=parseInventoryExport(await readFile(args.file,"utf8"));
      else {
        if(args.google!=="true")throw new Error("Use --google true");
        // One explicit read of the approved worksheet, never a periodic stock provider.
        const encoded=process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64;
        if(!encoded)throw new Error("Google credentials unavailable; export Инвентаризация as CSV and use --file");
        try {
          const credentials=parseGoogleServiceAccount(encoded);
          const auth=new GoogleAuth({credentials,scopes:["https://www.googleapis.com/auth/spreadsheets.readonly"]});
          const token=await auth.getAccessToken();
          const url="https://sheets.googleapis.com/v4/spreadsheets/1q5PxNK1_i5FgcpemI3wwRmCwZsww_iMM3j1WIJwVBz4/values/"+
            encodeURIComponent("'Инвентаризация'")+"?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE";
          const response=await fetch(url,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000),redirect:"error"});
          if(!response.ok)throw new Error();
          const body=await response.json() as {values?:unknown};
          if(!Array.isArray(body.values) || body.values.some(row=>!Array.isArray(row)))throw new Error();
          cells=body.values.map(row=>(row as unknown[]).map(String));
        } catch {throw new Error("Google read failed; export Инвентаризация as CSV and use --file");}
      }
    }
    if(command==="preview") {
      const preview=await new InitialInventoryImport(pool).preview(cells!,args["media-dir"]);
      console.log(JSON.stringify(preview,null,2));
      if(preview.errors.length)process.exitCode=1;
    } else {
      if(!args.actor || !args.reason || !args.at)throw new Error("--actor UUID --reason text --at ISO-date required");
      const actor=(await pool.query("SELECT telegram_user_id::text AS telegram_id FROM users WHERE id=$1 AND is_admin AND NOT is_blocked",[args.actor])).rows[0];
      if(!actor || !parseAdminIds(process.env.ADMIN_TELEGRAM_IDS ?? "").includes(actor.telegram_id as string))
        throw new Error("An existing unblocked Admin actor in current ADMIN_TELEGRAM_IDS is required");
      const op:InventoryOperation={actorUserId:args.actor,reason:args.reason,occurredAt:new Date(args.at),operationKey:args.key ?? "initial-import"};
      if(command==="apply") {
        const storageNames=["OBJECT_STORAGE_BUCKET","OBJECT_STORAGE_ENDPOINT","OBJECT_STORAGE_REGION","OBJECT_STORAGE_ACCESS_KEY_ID","OBJECT_STORAGE_SECRET_ACCESS_KEY"] as const;
        const storage=storageNames.every(key=>process.env[key]) ? new S3ObjectStorage(...storageNames.map(key=>process.env[key]!) as [string,string,string,string,string]):undefined;
        console.log(JSON.stringify(await new InitialInventoryImport(pool,storage).apply(cells!,args.confirm ?? "",op,args["media-dir"])));
      } else if(["receipt","correction","valuation"].includes(command ?? "")) {
        if(!args.key || !args.sku || args.cost===undefined || args.quantity===undefined)throw new Error("--key --sku --quantity --cost required; unknown cost is 'unknown'");
        const matches=await pool.query("SELECT id FROM product_variants WHERE sku=$1",[args.sku]);
        if(matches.rowCount!==1)throw new Error("Unknown SKU");
        if(!/^-?\d+$/.test(args.quantity))throw new Error("Invalid integer quantity");
        const cost=args.cost==="unknown"?null:parseMinor(args.cost);
        const kind=command==="receipt"?"RECEIPT":command==="correction"?"CORRECTION":"VALUATION";
        console.log(JSON.stringify(await new NativeInventoryService(pool).change(op,matches.rows[0].id,kind,Number(args.quantity),cost)));
      } else throw new Error("Use preview, apply, receipt, correction or valuation");
    }
  } finally {await pool.end();}
} catch(error) {
  // Our validation messages are safe; never print provider/DB errors or connection strings.
  const safe=error instanceof Error && !('code' in error) ? error.message : "Inventory command failed; inspect local database diagnostics";
  console.error(JSON.stringify({error:safe}));process.exitCode=1;
}
