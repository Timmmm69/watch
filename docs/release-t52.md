# T52 — release-кандидат native-дропшиппинга

Дата проверки: 2026-10-16, Europe/Minsk. **Локальная приёмка завершена;
production запуск BLOCKED внешними входами и proof.** T52 не объявлена полностью
завершённой для реальных продаж. Production-БД, реальные переводы, таблица и её
доступы не менялись, публичные продажи не открывались.

## Конкретный кандидат

Пакет: `outputs/t52/release-candidate.json`, `source-candidate.zip`, `evidence/`.
JSON содержит candidate commit, base HEAD, dirty status, точные SHA-256 исходников, общий
sourceSha256 и hashes отчётов; candidateId вычисляется из sourceSha256. Архив
содержит текущие T46–T52, включая сохранённые исходные пользовательские изменения.
Секреты, local DB, node_modules, dist и private production.env в него не входят.
Это конкретный снимок исходников и отдельный локальный commit в
`codex/t52-release-candidate`, не production approval. Main, исходный index и
пользовательские рабочие изменения сохранены; commit не отправлялся на remote.

Base HEAD: `91fcf46a41f3146159dcd7a52f444bc174f6b573`. Этот SHA предшествует рабочим
изменениям и **не подходит как RELEASE_TAG этого кандидата**. Candidate commit SHA
записан в output manifest, его tree точно соответствует source-кандидату. Перед deployment
нужны review этого commit, чистый deployment clone, проверки именно
candidate SHA и approval v2. Deploy проверяет HEAD/clean tree до build и не открывает
proxy в prepare/stage. Изменение кода требует нового снимка/затронутых проверок.

## Исправлено в T52

- Native production example и локальный ignored production.env переведены с
  Google на native; реальные origin/storage значения сохранены. Placeholder inputs
  не заменялись выдуманными. Compose overlay убирает Google secret; preflight
  проверяет authority API/worker/bootstrap и запрещает native без overlay.
- Approval v2 связывает native/DROPSHIPPER_MARKUP/R−D/получателя без Telegram и
  review обработки его данных; требует nativeWorkflow evidence. Старая Google
  attestation не сертифицирует новую модель. Legal/PII/recovery/security gates сохранены.
- Устранён fresh-install цикл: prepare выполняет миграции/legal bootstrap без
  фиктивного склада. Explicit provision-admin требует реальный разрешённый ID,
  имя/reference, аудит и незаблокированного пользователя; не создаёт Session/согласие.
  После preview/apply runtime readiness требует native authority. Stage запускает
  только internal services, upgrade открывает proxy лишь после прежних gates.
- Regression fixtures больше не TRUNCATE immutable history. Legacy shipment-test
  ожидает CONSUMED, API acceptance сериализует общие advisory locks; disposable
  browser fixture закрывает оставшиеся Next proxy sockets при teardown.
- Encrypted restore проверяет новые inventory/cash/expense/Return/ledger/payout facts,
  exact migrations и ACL. Evidence outputs исключены из Docker build context.

## Свежие локальные проверки T46–T51

Все данные ниже синтетические, PostgreSQL 16 на loopback. Рабочий DATABASE_URL не
использован. Основные fixture DB: /watch_t46, /watch_t47, /watch_t48 на 55450;
restore создаёт/удаляет уникальные /watch_restore_*; DB security — новый кластер
55452, остановленный после теста. Старые записи об успешных T46–T51 не считались proof.

| Проверка | Свежий результат |
|---|---|
| Workspace typecheck / build | PASS / PASS |
| Config | 48/48 |
| T46 schema/zero/legacy history/constraints | 9/9 |
| Полный API suite, 58 файлов | 603/603, без skip |
| Ops: release/prepare/stage/approval/backup/recovery | 18/18 |
| Compose topology/secrets | 4/4 |
| Least-privilege PostgreSQL app/migrator roles | 1/1 |
| Native bootstrap + encrypted isolated restore | 1/1 |
| Chromium: checkout/fulfillment/money/owner/returns | 26/26, без skip |

Проверены preview/apply/replay и фото/DRAFT, два R и current-D reconfirmation,
последний экземпляр/резерв/receipt/correction, отправка против отмены, replays и
rollback, неоплаченная доставка/частичная оплата, исходный hold и reject после него,
affected/unaffected release, переплата/refund/corrections, непригодные приёмки,
частичный/поздний Return после PAID, debt/allocations, неизвестные C/расходы и
reviewed zero, роли/CSRF/чужая PII, legacy snapshots и Minsk midnight/reconciliation.
Мобильные снимки checkout и inspection просмотрены; страницы не переполняются.

Сквозной restore fixture: C=24002, q=3, D=10000, R=14500 (все суммы в копейках).
Один пригодный частичный Return до release, затем PAID=9000 и один поздний
непригодный Return: native on-hand=1/value=8000/reserved=0, AVAILABLE=−4500,
cash=14500 после двух реальных **тестовых записей** refund. Старая PAID неизменна.
Hold=0 только для ускорения этой синтетической fixture; отдельные API tests
проверяют исходные 14 календарных дней. Это не разрешение менять production hold.

Первый широкий прогон обнаружил старые TRUNCATE/ACTIVE assertions и конкуренцию
общего sync lock; после исправления полный прогон зелёный. Первый browser teardown
завис на dev-proxy socket; после исправления финальный 26/26. Failed прогоны не
выдаются за acceptance, финальные логи находятся в evidence package.

## Реальные внешние проверки

Google Drive/Sheets connector прочитал metadata и A1:I1000 утверждённой
[Инвентаризации](https://docs.google.com/spreadsheets/d/1q5PxNK1_i5FgcpemI3wwRmCwZsww_iMM3j1WIJwVBz4/edit).
Вкладка/часовой пояс/девять заголовков совпадают; товарных строк нет. Никаких writes
или изменений sharing не было. Это только проверка источника, не live inventory acceptance.

Реальные Telegram initData/device smoke, production HTTP/network/alerts, media
upload/read/recovery, денежные переводы и host-loss restore **не выполнены**.
Local storage secret files присутствуют, но валидность/права bucket этим не доказаны.

## Что должен предоставить и сделать владелец

1. Заполнить фактические SKU/варианты/количества, общую закупку строки и D за штуку,
   подтверждённые описания/комплектацию; подготовить локальные фото по SKU и оригиналы.
   Сверить физический акт, затем preview/apply в разрешённую БД и проверить каталог.
2. Утвердить hosting/SSH management access, закрытую candidate-среду и exact production
   domain/origin, целевой private bucket/region/права. Доступ к публичному Google sync
   не нужен; CSV или существующего connector read достаточно для подготовки.
3. Через защищённые secret files предоставить отдельные postgres/migrator/app
   passwords/URLs, production bot token и webhook secret, CSPRNG CSRF.
   В ops/secrets на проверке есть только storage_access_key/storage_secret_key.
   Утвердить bot username, реальные Admin Telegram IDs, drop test IDs/устройства,
   SUPPORT_CONTACT и SLA; разрешить конкретный Telegram smoke/участников.
4. Предоставить reviewed Partner/Sales Terms/Privacy и PII policy, UUID/version/
   effectiveAt/точные hashes, retention/redaction/runbook; условия должны отражать
   реальных акторов и передачу данных получателя. Тексты/подписи не выдуманы.
5. Выбрать отдельный смонтированный backup target, внешний recovery key path,
   media backup/originals, alert destination, timers и план восстановления при потере
   хоста. Провести реальный encrypted isolated restore и внешнюю IPv4/IPv6 проверку.
6. Review локального candidate commit и чистый deployment clone; повторить gates по его SHA,
   собрать отсутствующие live proof в закрытой среде, заполнить approval v2 честными
   references/hashes. Текущие RELEASE_TAG/bot/Admin/legal/approval/SLA ещё placeholders.
7. Отдельно разрешить реальные переводы/возмещения и открытие продаж. До этого
   использовать только явно разрешённые тестовые записи и закрытую среду.

## Ограничения

- Денежный журнал ручной: приложение не доказывает банковский перевод и не является
  налоговой бухгалтерией. Сбор доставки владельцем вне R требует отдельного решения.
- Поступления/коррекции/valuation пока через CLI; импорт создаёт черновики, ссылки
  на фото не скачиваются автоматически. Неизвестные C/расходы сохраняются неизвестными.
- Local browser использует реальный API/Session/DB, но Telegram SDK/initData замещён;
  Chromium не заменяет реальные iOS/Android/Desktop Telegram проверки.
- DB backup не содержит media objects; локальный restore не доказывает отдельное
  production-хранилище, recovery ключа при потере хоста и доставку alerts.
- Docker Desktop Linux engine недоступен; попытка локального запуска не подняла
  Docker API. Production image build и запуск Compose services не выполнены.
  Проверены pnpm production build и resolved Compose topology/secrets, не работа контейнеров.
- Approval — operator attestation, не криптографическая подпись remote proof.

Инструкции: [импорт](initial-import-t52.md), [владелец](owner-guide-t52.md),
[дропшиппер](dropshipper-guide-t52.md), [launch checklist](production-launch-t45.md).
