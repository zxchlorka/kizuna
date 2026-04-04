# InfraView

Веб-приложение для просмотра и управления данными в PostgreSQL.
Один инструмент вместо разрозненных утилит для подключения, просмотра схем и работы с таблицами.

## Возможности

- Добавлять PostgreSQL подключения через UI (имя, хост, порт, БД, логин, пароль)
- Тестировать соединение с замером latency
- Просматривать дерево объектов: схемы → таблицы (с количеством строк)
- Просматривать структуру таблицы: колонки, типы, PK/FK
- Шифровать пароли подключений (AES-256-GCM)
- Тёмная/светлая/системная тема

## Стек

| Слой | Технологии |
|------|-----------|
| Backend | Go 1.26, Chi v5, pgx/v5 |
| Frontend | React 18, TypeScript, Vite, shadcn/ui, Zustand, TanStack Table |
| Deploy | Docker multi-stage, go:embed (один бинарь) |
| Порт | 9090 |

## Структура проекта

```
cmd/infraview/main.go              — entrypoint
internal/
  config/
    config.go                      — загрузка/сохранение config.json
    crypto.go                      — AES-256-GCM шифрование паролей
  connector/
    connector.go                   — Connector interface + общие типы
    manager.go                     — ConnectionManager (lazy init pool)
    postgres/
      postgres.go                  — PostgreSQL коннектор (Ping, GetInfo)
      schema.go                    — ListObjects, GetSchema
  api/
    router.go                      — Chi роутер, все маршруты
    handlers/
      health.go                    — GET /api/health
      connections.go               — CRUD подключений + /test + /info
      objects.go                   — /objects, /objects/:name/schema
  server/
    server.go                      — HTTP сервер + SPA fallback
frontend/
  src/                             — React приложение (Vite)
frontend.go                        — go:embed для frontend/dist
Dockerfile                         — multi-stage: frontend → backend → final/debug
Compose configuration              — infraview + infraview-debug + postgres
```

## REST API

```
GET    /api/health
GET    /api/connections
POST   /api/connections
PUT    /api/connections/:id
DELETE /api/connections/:id
POST   /api/connections/:id/test       → {ok, latency_ms}
GET    /api/connections/:id/info
GET    /api/connections/:id/objects?path=
GET    /api/connections/:id/objects/:name/schema
```

Все ошибки: `{"error": "message"}` + соответствующий HTTP код.

## Как запустить

### Docker (рекомендуется)

```bash
# Рекомендуемый workflow: пересобрать и поднять рабочий стек приложения
make compose-rebuild

# Эквивалент напрямую через Docker Compose
docker compose up --build -d postgres infraview

# Только postgres (для локальной разработки)
docker compose up postgres
```

Приложение доступно на [http://localhost:9090](http://localhost:9090)

### С отладчиком (Delve remote)

```bash
docker compose up infraview-debug
```

Затем в GoLand: `Run → Edit Configurations → + → Go Remote → localhost:2345`

### Локально (без Docker)

```bash
# 1. Поднять postgres
docker compose up postgres

# 2. Собрать фронт
cd frontend && npm install && npm run build && cd ..

# 3. Запустить backend
go run ./cmd/infraview
```

Config сохраняется в `./config.json` (создаётся автоматически при первом запуске).

## Переменные окружения

| Переменная | По умолчанию | Описание |
|-----------|-------------|---------|
| `CONFIG_PATH` | `./config.json` | Путь к файлу конфигурации |

В Docker `CONFIG_PATH=/data/config.json` задан через `ENV` в Dockerfile.

## Архитектура

Ключевой принцип — **единый Connector interface**. API-слой не знает тип источника данных, получает `Connector` из `ConnectionManager` и вызывает методы. Инициализация подключений выполняется лениво, по запросу.

```
HTTP Request
    → Chi Router
    → Handler (connections/objects)
    → ConnectionManager.Get(id)   ← lazy init
    → Connector (Postgres)
    → Response JSON
```

Пароли шифруются перед записью в `config.json` и расшифровываются при создании коннектора.
