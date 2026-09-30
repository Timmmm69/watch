# Google Sheets inventory (T18 / resolved U01)

Google Sheets is authoritative only for physical quantity. Set
`INVENTORY_PROVIDER=google_sheets`, `GOOGLE_SHEETS_SPREADSHEET_ID`,
`GOOGLE_SHEETS_WORKSHEET_NAME`, and `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64`
through the centralized runtime configuration. The last value is canonical base64
of the full service-account JSON with a valid RSA private key. Enable the Google
Sheets API and share the spreadsheet with the account's `client_email` as Viewer.
Do not commit or log credentials. Only selected service-account fields enter the
official Google auth client; auth uses the spreadsheets.readonly scope.

The first worksheet row must have unique `external_key` and `stock_quantity`
headers. Each fetch reads the entire quoted worksheet using Sheets API v4
values.get with UNFORMATTED_VALUE. Additional columns, including optional operator
`sku`, are ignored. Mapping is exclusively to Variant.inventory_external_key.
Numeric cells or decimal integer text are accepted; blank/boolean/fractional/
negative/overflow quantities fail closed through the existing normalizer. Entirely
blank rows are skipped. Duplicate keys remain visible to generic validation.
Missing configured keys become MISSING, never zero. Missing or ambiguous headers,
malformed API responses, permission/network/auth failures fail the fetch with a
sanitized error and retain previous stock until freshness expires.

Capabilities are completeSnapshot=true and reservationReconciliation=NONE.
No sourceVersion or sourceUpdatedAt is invented. U01 reconciliation authority is
MANUAL; reservation actions remain S09/S10 work. Sheet updates never change price,
commission, settlement, catalog status, attributes or media. Operators must enter
physical stock reflecting other sales channels; Sheets cannot prove absorption or
provide atomic cross-channel stock guarantees.

API startup injects this provider into the existing T17 orchestrator for Admin
sync. Worker startup runs J-03 immediately and every configured interval (default
120 seconds); freshness defaults to 600 seconds. Both use the same orchestrator
and dedicated PostgreSQL advisory lock. Timer attempts add no queue, custom mutex
or retry orchestration. Worker shutdown stops the timer and drains active syncs
before closing its pool. Config is validated at startup; readiness does not make
network calls to Google. Provider unset retains the existing disabled integration.
Google auth and Sheets fetch have 30-second network timeouts.

Live verification is PENDING until a real spreadsheet ID, worksheet, service
account and sharing permission are provided. Verify a successful Admin and worker
sync, missing/invalid rows, an outage followed by stale fail-closed stock, and
recovery. Automated tests mock only Google auth/API boundaries; PostgreSQL stock
apply, snapshot identity, advisory-lock races and fault recovery use a disposable
real PostgreSQL database.

API reference: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get
