# Первоначальный импорт

Источник: [утверждённая таблица](https://docs.google.com/spreadsheets/d/1q5PxNK1_i5FgcpemI3wwRmCwZsww_iMM3j1WIJwVBz4/edit),
вкладка «Инвентаризация». На проверке T52 2026-10-16 A1:I1000 содержит только
заголовки. Реальные товары не импортированы. Таблица и доступы не менялись.

1. Заполнить девять существующих колонок: SKU; Название / модель; Вариант;
   Количество, шт.; Закупка всего, BYN; Цена дропу за 1 шт., BYN; Ссылка на фото;
   Описание / характеристики; Примечание / комплектация. Закупка — сумма строки,
   D — за единицу. Не добавлять «Место хранения». Пустое количество недопустимо;
   неизвестную закупку оставить пустой, не писать вымышленный 0.
2. Экспортировать только вкладку в UTF-8 CSV/TSV. Подготовить одну локальную
   фотографию SKU.jpg/png/webp на SKU. Ссылка в таблице автоматически не скачивается.
   Фото копируются в private storage; оригиналы сохранить для восстановления.
3. На закрытой среде подготовить БД/валюту/Supplier/legal по production runbook.
   Fresh production: после разрешённого preflight `node ops/scripts/deploy.mjs prepare`.
   Writers/proxy остаются остановленными. В T52 production-команды не запускались.
4. Нужен настоящий Admin User UUID. Для первого импорта оператор может выполнить
   команду ниже с реальным ID из ADMIN_TELEGRAM_IDS, настоящим именем и безопасной
   ссылкой на проверку личности. Команда не создаёт Session/согласие и не заменяет
   Telegram login; повтор безопасен, чужой/заблокированный ID отклоняется.

```sh
docker compose --env-file ops/docker/production.env -f ops/docker/compose.production.yml -f ops/docker/compose.native.yml run --rm --no-deps api node apps/api/dist/operations/cli.js provision-admin '<Telegram ID>' '<настоящее имя>' '<безопасный reference>'
```

5. Выполнить CLI **того же release image**, примонтировав CSV/photos read-only
   (например /run/import) и используя runtime-secrets entrypoint/app DB role:

```sh
# Префикс: тот же docker compose ... run --rm --no-deps -v /secure/import:/run/import:ro api
node apps/api/dist/inventory/cli.js preview --file /run/import/inventory.csv --media-dir /run/import/photos
node apps/api/dist/inventory/cli.js apply --file /run/import/inventory.csv --media-dir /run/import/photos --confirm '<confirmation из preview>' --actor '<Admin UUID>' --reason '<акт пересчёта>' --at '<фактическое ISO-время>'
```

Локальный эквивалент: `pnpm --filter @watch/api inventory preview|apply ...` с
явным INVENTORY_PROVIDER=native, точным разрешённым DATABASE_URL и storage secrets.
`--google true` — опциональное одноразовое чтение утверждённой вкладки с отдельным
read-only credential. CSV не требует Google credentials.

6. Проверить пустой errors, warnings, mappings, SKU/units, knownCostMinor и
   unknownCostSkus. Confirmation связывает строки/сопоставления/bytes фото.
   Любое изменение требует нового preview. `--at` не может быть в будущем.
   Повтор apply с исходным confirmation не добавляет/не сбрасывает остатки.
7. После apply можно выполнить `deploy.mjs stage`: internal API/web/worker проходят
   readiness, публичный proxy остаётся остановленным. Для UI нужен отдельно
   разрешённый закрытый/allowlisted доступ; не публиковать порты API/БД/web.
   Импорт создаёт DRAFT. Проверить описание, вариант, D, категории, витринное фото
   и материалы, затем активировать варианты/товары. Неполные карточки не публиковать.
8. Сверить акт с native on-hand/value, резервом 0 и доступностью с учётом буфера.
   После всех gates и отдельного разрешения открыть продажи выполнить `deploy.mjs upgrade`: он заново проверяет
   migrations/bootstrap/readiness перед proxy.

Legacy stock автоматически не переносится: сначала разобрать ACTIVE резервы и
пересчитать товар. После старта поступления/коррекции/оценка — через
[существующий журнал/CLI](native-inventory-t47.md), не повторной инициализацией.
