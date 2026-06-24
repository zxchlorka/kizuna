# План оптимизации подключений и загрузки данных

Дата: 2026-06-19  
Статус: план, без реализации

## Цели

- Убрать лишние запросы при открытии приложения, подключения, таблицы, Redis key и Kafka topic.
- Сделать состояние подключения единым: сначала понятный bootstrap/health, потом tree/data.
- Не показывать пачку одинаковых ошибок, когда источник недоступен.
- Сохранить существующие защитные лимиты для PG/Redis/Kafka и не грузить источники полными сканами.
- Не хранить большие данные в браузере, `config.json` или localStorage. Допустимы только короткоживущие in-memory metadata cache и маленький health cache.

## Принципы

1. Один пользовательский action должен иметь один понятный request graph.
2. Одинаковые concurrent запросы должны дедуплицироваться через in-flight promise/singleflight.
3. UI не должен показывать `empty state`, пока конкретный request не завершился успешно.
4. Ошибка подключения должна быть connection-level состоянием, а не десятком локальных баннеров.
5. Exact counts и metadata должны быть lazy/bounded. Если точный расчет дорогой, показываем approximate/unknown и даем refresh.
6. Caches должны быть ограничены TTL, размером и scope. Не кешировать rows/messages/key values надолго.

## Найденные проблемные зоны

### 1. Bootstrap и health

Сейчас health запускается не централизованно:
- на connection list после `fetchConnections`;
- при клике по карточке уже после `navigate`;
- на прямом `/connections/:id` health не стартует как обязательный шаг.

План:
- Ввести единый frontend flow `ensureConnectionReady(connId)`.
- На `/connections/:id` сначала загрузить connection metadata, потом сразу стартовать health ping и tree root.
- Не блокировать весь экран только ping'ом, но показывать один компактный статус `checking/offline/online`.
- Health failures не должны создавать toast storm. Только статус в sidebar/header + один retry action.
- Увеличить пользу health cache, но сделать `force` на ручной retry и при изменении конфига.

Ожидаемый результат:
- При открытии подключения виден быстрый `checking`.
- Не бывает ситуации, где tree/data уже сыпятся ошибками, а ping еще не стартовал.

### 2. Дедупликация frontend запросов

Сейчас несколько компонентов независимо вызывают `fetchTree`, `fetchSchema`, `fetchData`, `fetchTopicChildren`, `fetchMessages`.

План:
- Добавить in-flight maps в stores:
  - `treeRequests[connId::path]`;
  - `schemaRequests[tabId/object]`;
  - `dataRequests[tabId/object/optsSignature]`;
  - `kafkaChildrenRequests[tabId/topic]`;
  - `kafkaMessageRequests[tabId/topic/filterSignature]`.
- Для одинакового ключа возвращать существующий promise.
- Для stale requests продолжить использовать request id/abort logic, но не запускать новый request без причины.
- В event handlers вызывать `fetchData(..., nextOpts)`, а не `setOpts()` и потом `fetchData()` со старым snapshot.

Ожидаемый результат:
- React StrictMode/dev не удваивает реальные backend calls.
- Быстрые retry/click не создают параллельные одинаковые запросы.

### 3. Единая модель ошибок

Сейчас ошибки появляются из разных мест: health, tree, schema, data, Kafka messages, toast.

План:
- Разделить ошибки по типам:
  - `connectionError`;
  - `treeErrorByPath`;
  - `schemaError`;
  - `dataError`;
  - `mutationError`;
  - `kafkaChildrenError`;
  - `kafkaMessagesError`.
- Для unavailable/timeout на уровне connector показывать один connection-level banner.
- Локальные errors показывать только если connection healthy, но конкретная операция упала.
- Добавить toast dedupe: одинаковые `tone + title + message` в течение 3-5 секунд не добавлять повторно.

Ожидаемый результат:
- Если PG/Redis/Kafka недоступны, слева не появляется пачка одинаковых ошибок.
- Retry находится в одном понятном месте.

### 4. Object tree: path-level loading/error

Сейчас `treeLoading` общий, а ошибка хранится по connection. Для раскрытой PG schema ошибка child-запроса легко превращается в `No tables`.

План:
- Перейти на состояние по ключу `connId::path`:
  - `treeItems[key]`;
  - `treeLoadingByKey[key]`;
  - `treeErrorByKey[key]`;
  - `treeLoadedByKey[key]`.
- Empty state показывать только если `loaded && !loading && !error && items.length === 0`.
- Для schema children показывать skeleton/error внутри раскрытой схемы, а не общий root error.
- `refreshTree` должен обновлять root и раскрытые paths с дедупликацией.

Ожидаемый результат:
- PG schema больше не показывает `нет таблиц`, если запрос еще идет или упал.
- Retry конкретной схемы не перезагружает весь tree без необходимости.

### 5. Backend ConnectionManager

Сейчас `createConnector` держит global write lock на время factory/ping, а cached connector валидируется ping'ом уже через 5 секунд.

План:
- Сделать per-connection singleflight для создания connector.
- Не держать global manager lock во время dial/ping.
- Хранить in-memory cooldown для недоступного подключения, чтобы 5 компонентов не пытались одновременно реконнектиться.
- Разделить `Get()` и explicit health validation:
  - обычные data/tree запросы используют cached connector без ping на каждый короткий TTL;
  - health endpoint делает ping явно;
  - при реальной ошибке connector удаляется/помечается degraded.
- Пересмотреть `connectorValidationTTL = 5s`; для UI workloads это слишком часто.

Ожидаемый результат:
- Один медленный/мертвый datasource не блокирует остальные.
- Первый retry после успешного прогрева не повторяет лишний ping на каждый endpoint.

### 6. PostgreSQL оптимизация

Проблемы:
- `PgTableView` вызывает `fetchSchema` и `fetchData` параллельно.
- Backend `GetData` внутри снова вызывает `GetSchema`.
- `GetSchema` делает несколько последовательных `information_schema` запросов.
- `GetData` всегда делает exact `count(*)`.

План:
- Initial table open:
  - основной запрос: `fetchData`, потому что response уже содержит `columns`;
  - `fetchSchema` нужен только для `referenced_by`/FK metadata и может грузиться lazy/background один раз.
- Добавить bounded schema metadata cache в PG connector:
  - key: `schema.table`;
  - TTL: 30-60 секунд;
  - max entries;
  - invalidate on DDL/mutate where schema changes.
- Убрать duplicate schema load между frontend `fetchSchema` и backend `GetData`.
- Для count:
  - по умолчанию использовать `LIMIT + 1` для `has_more`;
  - exact `count(*)` делать lazy/on demand или с коротким timeout;
  - для больших таблиц показывать approximate из `pg_class.reltuples`/stats.
- Для tree row counts оставить approximate `pg_stat_user_tables`, не делать count per table.

Ожидаемый результат:
- Открытие PG таблицы не делает два одинаковых metadata прохода.
- Большие таблицы не зависают на `count(*)`.
- Pagination остается рабочей через `has_more`, даже если total approximate/unknown.

### 7. Redis оптимизация

Проблемы:
- Если connection metadata еще не загружена, tree может не распознать Redis и не включить paged режим.
- Redis key view вызывает schema и data параллельно, оба снова получают type/ttl/length.
- Legacy `ListObjects` может сканировать до 5 секунд.

План:
- Не монтировать `ObjectTree`, пока current connection type неизвестен.
- Для Redis UI всегда использовать `paged=1`; legacy `ListObjects` оставить только для совместимости API/tests.
- Добавить short-lived in-memory cache key metadata:
  - key type;
  - ttl;
  - length/cardinality;
  - TTL cache 5-15 секунд;
  - не кешировать values.
- Initial Redis key open:
  - `fetchData` как основной запрос;
  - schema/metadata либо из data response, либо lazy отдельным запросом без дублирования type/ttl.
- Сохранять текущие scan budgets:
  - page max keys;
  - max scans;
  - time budget;
  - cursor-based load more.

Ожидаемый результат:
- Redis не пытается на старте просканировать больше, чем нужно.
- Retry помогает реже, потому что первый flow не конфликтует сам с собой.

### 8. Kafka оптимизация и UX

Проблемы:
- `TabBar` показывает SQL Console для Kafka.
- Topic list делает metadata + offsets для всех topics.
- Topic view отдельно грузит children и messages.
- Consumer groups могут быть дорогими на больших кластерах.

План:
- Для Kafka заменить `New SQL` на Kafka-specific action или скрыть кнопку.
- Topic list:
  - сначала грузить topics + partitions;
  - message counts/offset estimates грузить lazy или bounded background;
  - если offsets падают, не считать это ошибкой всего списка.
- Topic view:
  - messages грузить первым;
  - partitions/groups грузить lazy по вкладке или background с отдельным status.
- Consumer groups:
  - ограничить/пагинировать;
  - не делать `FetchOffsets` для всех groups без необходимости;
  - показывать partial result, если часть groups недоступна.

Ожидаемый результат:
- Kafka вкладка не предлагает неподдерживаемую SQL Console.
- Большие Kafka кластеры открываются без долгого metadata storm.

### 9. Request budgets и лимиты

Существующие лимиты нужно сохранить и явно закрепить:
- frontend default timeout остается, но для тяжелых controlled операций можно иметь отдельный timeout;
- Redis scan budgets остаются обязательными;
- Kafka consume/produce timeout остаются bounded;
- PG exact count получает отдельный короткий timeout или становится optional.

Дополнительно:
- Добавить structured logs для request count/duration по типам:
  - `connection_bootstrap`;
  - `tree_root`;
  - `tree_children`;
  - `schema`;
  - `data`;
  - `count`;
  - `redis_scan_page`;
  - `kafka_metadata`;
  - `kafka_consume`.

## Предлагаемый порядок реализации

### Phase 1: быстрые UX fixes без архитектурного риска

1. Скрыть/заменить SQL Console для Kafka.
2. Добавить toast dedupe.
3. Не монтировать tree до загрузки current connection type.
4. Добавить health bootstrap на `/connections/:id`.

Проверка:
- `npm --prefix frontend run build`;
- Playwright: PG/Redis/Kafka connection open, недоступный источник, Kafka tab bar.

### Phase 2: frontend request orchestration

1. Добавить in-flight dedupe в stores.
2. Разделить tree loading/error по `connId::path`.
3. Разделить schema/data errors в `data` store.
4. Починить `setOpts + fetchData` так, чтобы запрос всегда использовал next opts.

Проверка:
- Playwright network/request count на open connection/table/key/topic.
- E2E сценарии retry на недоступном PG/Redis.

### Phase 3: backend connector lifecycle

1. Per-connection singleflight в `ConnectionManager`.
2. Убрать global lock во время dial/ping.
3. Добавить failed-connection cooldown.
4. Разделить обычный `Get` и health validation.

Проверка:
- `go test ./...`;
- тесты concurrent `Get` для одного и разных connection ids.

### Phase 4: PG metadata/data optimization

1. Schema metadata cache с TTL/max entries.
2. Убрать duplicate initial schema requests.
3. Перевести pagination на `limit + 1`/`has_more` как основной путь.
4. Exact count сделать optional/lazy/bounded.

Проверка:
- backend tests на schema cache invalidation;
- frontend table open request count;
- большая таблица/медленный count не ломает initial render.

### Phase 5: Redis/Kafka deeper optimization

1. Redis key metadata cache без value cache.
2. Redis UI только через paged tree loading.
3. Kafka lazy offsets/groups.
4. Kafka partial metadata states.

Проверка:
- Redis large keyspace не уходит в legacy full scan;
- Kafka topic list открывается без ожидания всех offsets/groups.

## Acceptance criteria

- Открытие connection page:
  - максимум один health request;
  - максимум один root tree request;
  - нет schema/data requests до выбора объекта.
- Открытие PG table:
  - нет duplicate schema metadata request;
  - initial render не зависит от exact `count(*)`;
  - retry не запускает параллельные одинаковые requests.
- Открытие Redis:
  - tree использует paged scan;
  - key data не дублирует type/ttl больше необходимого;
  - values не кешируются надолго.
- Открытие Kafka:
  - SQL Console недоступна/скрыта;
  - topic list не падает целиком из-за offset estimate;
  - messages, partitions, groups имеют независимые loading/error states.
- Недоступный источник:
  - один connection-level error;
  - нет toast storm;
  - retry запускает один controlled request path.

## Что не делать

- Не хранить rows/messages/key values в localStorage.
- Не делать eager connect всех connections на старте.
- Не выполнять `count(*)` для всех таблиц в tree.
- Не сканировать весь Redis keyspace без cursor/budget.
- Не делать Kafka offsets/groups для всего кластера как обязательный blocking step.
- Не добавлять source-specific branching в API handlers сверх существующего connector interface.

