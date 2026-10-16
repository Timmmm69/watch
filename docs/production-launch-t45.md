# T45/T52 — checklist запуска native-дропшиппинга

Источник: FULL_BUILD_SPEC.md §30. Старые результаты T45 не подтверждают T46–T52.
Свежие доказательства и кандидат: [T52](release-t52.md). **Продажи BLOCKED** до
закрытия всех применимых пунктов для production SHA и выбранной среды.

## Доказательства и approval

Сохранять SHA, время, оператора, среду, ожидаемый/фактический результат и SHA-256
безопасного отчёта. Секреты и PII хранить отдельно. Сначала использовать закрытую
приёмочную среду и разрешённых участников. Локальные синтетические данные не
заменяют настоящую инвентаризацию, Telegram, сеть или восстановление после потери хоста.

Скопировать [пример approval](../ops/scripts/production-approval.example.json)
в защищённый файл вне git. `schemaVersion=2`, `operatingModel.inventoryProvider=native`,
`orderFlow=DROPSHIPPER_MARKUP`, `recipientTelegramRequired=false`, `ownerReceives=R`,
`remuneration=R_MINUS_D`. `termsCoverRecipientData=true` — только после реального
review документов по участникам и данным получателя. Старый/другой режим не принимается.

Не менять accepted/approved/passed на true без соответствующего подтверждения.
`acceptance.inventoryLive` доказывает пересчёт, preview/apply и сверку SKU/C/D/фото
с внутренним складом. Обязательный `nativeWorkflow` — свежая приёмка T46–T52.
Сохраняются T39–T44, migrations, financial, telegramDevice, encryptedBackupRestore,
externalNetwork, noDeadLinks/noKnownP0P1. Google outage native-режиму не требуется.

JSON связывает SHA/config/legal hashes и references, но не проверяет подлинность
отчётов или банковский перевод. Их проверяет ответственный оператор.
`WATCH_PRODUCTION_APPROVAL_PATH` — абсолютный файл, read-only mount
`/run/production-approval.json`; runtime WATCH_PRODUCTION_APPROVAL_FILE указывает туда.

## Закрытая подготовка и final approval

`prepare`, `stage` и безопасный alias `fresh` запускаются с
`WATCH_CLOSED_ACCEPTANCE=1` внутри Compose API/worker/bootstrap. Они допускают
только `passed=false` для `inventoryLive`, `nativeWorkflow`, `telegramDevice`.
Для незавершённого proof сохраните честный отчёт о pending состоянии, его reference
и SHA-256; не выдавайте план за успешную приёмку. Все остальные gates остаются
обязательными: exact source SHA/clean checkout, config/legal/PII, финансовые и
security проверки, backup/recovery и externalNetwork. `NODE_ENV=production`
сохраняется; `NODE_ENV=test` для подготовки недопустим.

1. Из чистого checkout нужного SHA: `node ops/scripts/deploy.mjs prepare`.
   `fresh` теперь означает такую же закрытую подготовку, без открытия traffic.
2. Provision/import CLI из того же image выполняйте с `WATCH_CLOSED_ACCEPTANCE=1`
   **в окружении Compose**, например:
   `WATCH_CLOSED_ACCEPTANCE=1 docker compose --env-file /secure/production.env -f ops/docker/compose.production.yml -f ops/docker/compose.native.yml run --rm --no-deps api node apps/api/dist/operations/cli.js config`.
   Используйте те же Compose project, secrets и read-only bootstrap/import mounts.
3. После явного импорта: `node ops/scripts/deploy.mjs stage`. API/web/worker
   работают во внутренней сети, public reverse-proxy остаётся остановленным.
   Разрешённый закрытый доступ для приёмки организуется отдельно; не публикуйте
   API/DB/web порты. Closed marker — политика оператора, не замена сетевой изоляции.
4. Если prepare прерван после создания volume/миграций, не удаляйте данные и
   не повторяйте fresh. Исправьте причину и выполните `stage`: миграции/bootstrap
   идемпотентно продолжатся. Если склад ещё не импортирован, readiness останется
   закрытой; завершите provision/import тем же CLI и повторите `stage`.
5. По итогам настоящих live proof обновите approval для того же SHA/config и
   отдельно получите решение владельца открыть продажи. Только
   `node ops/scripts/deploy.mjs upgrade` может открыть public proxy: команда
   очищает closed marker, заново требует полный approval, пересоздаёт services
   и проверяет readiness. Pending proof блокирует opening даже после здорового
   private stage. Ошибка preflight останавливает proxy/writers до исправления.

Ручной `docker compose up reverse-proxy` не является разрешённым launch-путём.
Не сохраняйте closed marker как постоянный обход final approval.

## A. Release и конфигурация

- [ ] Source-кандидат зафиксирован полным Git SHA; build/миграции/проверки повторены
  для него. Все images/RELEASE_TAG/approval привязаны к тому же SHA.
  Deploy проверяет HEAD и чистый checkout до build/остановки сервисов; одного image tag недостаточно.
- [ ] Typecheck/build, zero/legacy migrations, native/financial/role/browser suites
  прошли без скрытых skip. Старая история сохранена.
- [ ] API/worker/bootstrap используют native env и overlay; Google secret/sync/
  freshness не обязательны. Нельзя переключить инициализированную authority назад.
- [ ] Реальны hosting, HTTPS domain, private storage, отдельный backup mount,
  recovery ключа и доставка alerts. Placeholders отсутствуют.
- [ ] Утверждены Admin Telegram IDs, bot/domain, SUPPORT_CONTACT, SLA,
  явный ORDER_HOLD_DAYS (базовое значение 14) и минимум выплаты BYN.
- [ ] Reviewed Partner/Sales Terms и Privacy отражают владельца, дропа, получателя
  без Telegram, передачу PII, R−D, ручные деньги/возмещение, hold и возвраты.
  UUID/version/hash/effectiveAt совпадают с bootstrap.
- [ ] PII policy внутри WATCH_BOOTSTRAP_DIR, hash точных UTF-8 bytes совпадает;
  retention/manual redaction и права утверждены. Автоудаление не придумано.
- [ ] Раздельные app/migrator/admin secrets, immutable grants, CSRF/roles,
  HTTPS/security headers и изоляция БД сохранены.

## B. Первый склад и переход

- [ ] Заполнена [Инвентаризация](https://docs.google.com/spreadsheets/d/1q5PxNK1_i5FgcpemI3wwRmCwZsww_iMM3j1WIJwVBz4/edit).
  Закупка — всего за строку; D — за единицу. Нет «Места хранения».
- [ ] Реальные количества/C/D/фото сверены; неизвестная C не заменена нулём.
  SKU устойчивы, работающие карточки не перезаписаны.
- [ ] Existing DB: encrypted backup, остановка старых writers, разбор ACTIVE
  legacy reservations и физическая сверка перед cutover.
- [ ] Fresh: `deploy.mjs prepare` → явный provision-admin разрешённого владельца →
  preview/apply → `deploy.mjs stage` (internal only) → проверка/публикация карточек
  через разрешённый закрытый доступ → `deploy.mjs upgrade` после решения раздела D.
  [Инструкция](initial-import-t52.md). Prepare не запускает writers/proxy;
  обычная readiness до выбора native authority остаётся закрытой.
- [ ] Повтор apply не прибавил товар; SKU/стоимость совпадают с актом, фотографии
  действительно открываются, неполные карточки остаются DRAFT.

## C. Реальный smoke разрешённой среды

- [ ] Telegram на согласованных устройствах: /start, /help, свежий login/relaunch,
  back, каталог/фото/материалы, актуальные Terms, Session/CSRF и запреты ролей.
- [ ] Дроп создал свой заказ с R>=D и получателем без аккаунта; чужая R/PII и C
  недоступны, изменение D потребовало повторного подтверждения.
- [ ] Последний экземпляр/два заказа, cancel против ship, повторы checkout/ship/
  receipts/inspection/payout дали один эффект.
- [ ] Резерв → фактическое получение R → SHIPPED (одно списание) → DELIVERED →
  исходный hold → release R−D → REQUESTED → внешний перевод → PAID.
  Неоплаченная доставка не высвободила наценку; CONFIRMED не означает оплату.
- [ ] Частичный Return и отдельный refund; только пригодная приёмка добавила склад
  один раз; непригодная C осталась потерей. Копейки распределены точно.
  Поздний Return после PAID дописал долг, прежняя выплата сохранена.
- [ ] Переплата — обязательство; неизвестные C/расходы — «нет данных»; review нуля
  явный. SKU/дропы/сводка сходятся, даты Europe/Minsk проверены.
- [ ] Реальные переводы имеют отдельное разрешение владельца. Синтетический PAID
  не считается доказательством внешнего перевода.
- [ ] Encrypted backup восстановлен изолированно; проверены native stock, история,
  ledger/allocations/legal/migration hashes/ACL и recovery ключа с отдельного пути.
  Media/originals восстановлены отдельно: DB dump не содержит изображений.
- [ ] Из недоверенной сети: только 80/443, SSH ограничен/key-only, нет публичных
  DB/API/web/Docker/Caddy admin; IPv4/IPv6, HSTS, alerts/timers проверены.

## D. Решение

- [ ] Ответственный сверил A–C, exact SHA/config/hashes и реальные proof.
- [ ] Владелец отдельно разрешил открытие продаж; решение и evidence сохранены.

Пустой пункт сохраняет BLOCKED. Эта работа не открывает traffic и не разрешает
реальные переводы. [Недостающие входы и действия](release-t52.md).
