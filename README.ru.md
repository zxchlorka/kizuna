<div align="center">

# 絆 kizuna

<p><strong>Единый веб-интерфейс для PostgreSQL, Redis и Kafka.</strong><br>
Просматривайте данные, работайте с сообщениями и переходите между связанными записями без смены инструментов.</p>

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-f59e0b.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Docker Image](https://img.shields.io/docker/v/zxchlorka/kizuna?sort=semver&logo=docker&logoColor=white&label=docker)](https://hub.docker.com/r/zxchlorka/kizuna)

[English](README.md) · Русский

</div>

<p align="center">
  <picture>
    <source srcset=".github/assets/hero.webp" type="image/webp">
    <img src=".github/assets/hero.png" width="960" alt="⌘K открывает топик Kafka; правый клик по событию ведёт в Redis-профиль по его user_id, а оттуда — к заказам этого пользователя в PostgreSQL">
  </picture>
</p>

## Зачем Kizuna

Kizuna заменяет разрозненный набор из pgAdmin, Redis Desktop Manager и Kafka UI одним компактным приложением. Его цель — сделать ежедневную работу с данными быстрее: открыть таблицу, ключ или сообщение, изменить нужное значение и сразу перейти к связанной сущности в другом источнике.

Это self-hosted приложение для инженеров, аналитиков и команд поддержки. В production оно запускается одним контейнером и не требует отправлять данные во внешний сервис.

## Быстрый старт

```bash
docker run -d --name kizuna -p 127.0.0.1:9090:9090 -v kizuna-data:/data zxchlorka/kizuna
```

Откройте [http://localhost:9090](http://localhost:9090) и добавьте первое подключение. Конфигурация хранится в Docker-томе `kizuna-data`, а пароли подключений шифруются AES-256-GCM. Образ собран под amd64 и arm64 и есть также в GHCR: `ghcr.io/zxchlorka/kizuna`.

Обновление — `docker pull zxchlorka/kizuna && docker rm -f kizuna` и та же команда `docker run`; подключения останутся в томе.

<details>
<summary><b>Docker Compose</b></summary>

```yaml
services:
  kizuna:
    image: zxchlorka/kizuna
    ports:
      - "127.0.0.1:9090:9090"
    volumes:
      - kizuna-data:/data
    restart: unless-stopped

volumes:
  kizuna-data:
```

</details>

<details>
<summary><b>Сборка из исходников</b></summary>

```bash
git clone https://github.com/zxchlorka/kizuna.git
cd kizuna
docker compose up -d --build
```

Без Docker нужны Go 1.26+ и Node 20+:

```bash
cd frontend && npm install && npm run build && cd ..
go run ./cmd/kizuna
```

Фронтенд встраивается в один Go-бинарь; приложение слушает порт `9090`.

</details>

## Подключения

Подключайте три типа источников в одном мастере: **PostgreSQL**, **Redis** и **Kafka**. Redis поддерживает standalone, Cluster и Sentinel; для Kafka доступны несколько брокеров, SASL и TLS с пользовательским CA bundle; для PostgreSQL — TLS вплоть до `verify-full` и вставка готовой connection string.

- Подключения можно искать, фильтровать и группировать по тегам. Подключение с тегом `production` открывается под предупреждающим баннером.
- Ссылка в адресной строке ведёт на открытый объект вместе с фильтрами — расследование можно передать коллеге одной ссылкой.
- Вкладки и черновики SQL переживают перезагрузку страницы.

<p align="center">
    <picture>
      <source srcset=".github/assets/connections-types.webp" type="image/webp">
      <img src=".github/assets/connections-types.png" width="960" alt="Мастер нового подключения с выбором PostgreSQL, Redis и Kafka">
    </picture>
</p>

## ⌘K — переход куда угодно

**⌘K** (Ctrl K) открывает любое подключение, таблицу, представление, топик или Redis-неймспейс с любой страницы. По `ord` находится `public.orders` на каждом подключении, где она есть; второе слово сужает по подключению: `ord stage`. Ищет только по тому, что уже загружено в браузер, поэтому открытие палитры не шлёт запросов в базы.

<p align="center">
  <picture>
    <source srcset=".github/assets/command-palette.webp" type="image/webp">
    <img src=".github/assets/command-palette.png" width="960" alt="Палитра ⌘K находит public.orders на двух подключениях, вторым словом сужает до stage и открывает таблицу">
  </picture>
</p>

## PostgreSQL — от схемы до запроса

Откройте схему, таблицу или представление прямо из дерева. В табличном режиме есть сортировка, фильтры, пагинация, типы колонок и быстрые переходы по foreign key. Режим редактирования поддерживает массовые изменения, добавление и удаление строк, а breadcrumbs сохраняют контекст навигации.

<p align="center">
  <picture>
    <source srcset=".github/assets/postgres-explorer.webp" type="image/webp">
    <img src=".github/assets/postgres-explorer.png" width="960" alt="Переход от дерева схем PostgreSQL к таблице orders и фильтрации по user_id">
  </picture>
</p>

- SQL-консоль: автодополнение, история, многооператорные скрипты, безопасный `EXPLAIN` и подтверждаемый `EXPLAIN ANALYZE`.
- DDL-операции и инспектор индексов — без переключения в отдельный клиент.
- Прямые и обратные внешние ключи: переход к родительской записи, **Referenced By** и возврат по breadcrumbs.
- **Show DDL** — `CREATE` для таблицы, представления или материализованного представления, как его пишет `pg_dump`.
- **Overview**: активные сессии и блокировки, тяжёлые запросы из `pg_stat_statements`, размеры таблиц и dead tuples, лаг репликации, неиспользуемые индексы, переполнение sequence.
- Строку можно скопировать как `SELECT`, `INSERT`, `UPDATE` или `DELETE`; результаты — выгрузить в CSV или JSON.
- `bigint` и `numeric` показываются как есть, без округления до double.

<p align="center">
  <img src=".github/assets/sql-console.png" width="960" alt="SQL-консоль Kizuna">
</p>

## Redis — ключи, типы и CLI

Дерево ключей группируется по префиксам. Для String, Hash, List, Set, Sorted Set, Stream и RedisJSON Kizuna открывает подходящий редактор; здесь же доступны TTL, создание ключей и массовые операции.

Встроенный Redis CLI форматирует результат команды и показывает кнопку `open <key>` для распознанного ключа. Например, после `HGETALL profile:1001` можно сразу открыть `profile:1001` в типизированном редакторе — без копирования имени ключа.

- **Overview**: память против `maxmemory`, eviction, фрагментация, а в кластере — мастера и карта всех 16384 слотов с пропущенными.
- Сравнение до пяти ключей одного типа: общие значения подсвечены, списки через запятую сравниваются поэлементно.
- Переименование, дублирование, копирование ключа в другое подключение и в JSON — в том числе в кластере и без прав на `RESTORE`.
- Фильтр дерева через `SCAN MATCH` на сервере и экспорт id неймспейса в JSON-список.

<p align="center">
  <picture>
    <source srcset=".github/assets/redis-cli.webp" type="image/webp">
    <img src=".github/assets/redis-cli.png" width="960" alt="Redis CLI выполняет HGETALL profile:1001 и предлагает сразу открыть этот ключ">
  </picture>
</p>

<p align="center">
  <img src=".github/assets/redis-keys.png" width="960" alt="Типизированный просмотр Redis-ключа">
</p>

## Kafka — сообщения и управляемый produce

Просматривайте топики, партиции, consumer groups и JSON-сообщения в одном окне. Поля сообщений можно использовать для фильтрации и переходов к связанным данным.

Производитель умеет отправлять одно сообщение, набор JSON-объектов в режиме **Multi** или пакет, развёрнутый из шаблона в режиме **Loop**. Перед отправкой Kizuna показывает точный preview каждого сообщения: выражения `{{i}}`, шаг и количество можно проверить до записи в Kafka.

- Поиск по топику: по ключу, заголовку или полям JSON, несколько условий через AND/OR, `equals` / `contains` / «поле есть». Прогресс скана виден, остановить можно в любой момент.
- Переход по offset или времени, чтение от новых к старым и обратно.
- Выбранные поля JSON выводятся отдельными колонками.
- Сброс offset'ов consumer group — на начало, конец или момент времени; до отправки видно, сколько сообщений группа перечитает или пропустит.
- Вкладка Config: каждая настройка топика с источником значения и тем, что будет без override.

<p align="center">
    <picture>
      <source srcset=".github/assets/kafka-produce.webp" type="image/webp">
      <img src=".github/assets/kafka-produce.png" width="960" alt="Kafka producer переключается между режимами Multi и Loop и показывает предварительный просмотр пакета сообщений">
    </picture>
</p>

<p align="center">
  <img src=".github/assets/kafka-messages.png" width="960" alt="Браузер Kafka-сообщений">
</p>

## Связи между источниками

Одно и то же значение живёт в трёх местах сразу: `user_id` в событии Kafka, ключ `profile:1008` в Redis, колонка в `public.orders`. Обычно это означает копирование значения из окна в окно. Kizuna позволяет описать переход один раз.

**Настройка — полминуты.** Правый клик по сообщению → **Create link…** → указываете поле `user_id` и говорите, что оно адресует ключ `profile:*` в Redis. Всё.

**Дальше это работает само.** Правый клик по любому сообщению этого топика — и в меню уже висит `Redis: profile:1008`. Оттуда тем же движением в `public.orders`, отфильтрованные по тому же `user_id`. Фильтр, breadcrumb и обратные переходы Kizuna строит сама — ни одного скопированного значения.

<p align="center">
    <picture>
      <source srcset=".github/assets/cross-source-links.webp" type="image/webp">
      <img src=".github/assets/cross-source-links.png" width="960" alt="Создание связи из Kafka-сообщения и переход по ней в Redis-профиль и заказы PostgreSQL">
    </picture>
</p>

<p align="center">
  <img src=".github/assets/links-menu.png" width="960" alt="Меню связей у Redis-ключа: прямой переход в PostgreSQL и обратные переходы к Kafka и к заказам">
</p>

<p align="center">
  <img src=".github/assets/links-settings.png" width="960" alt="Настройка cross-source links">
</p>

## В одном контейнере

- Тёмная, светлая и системная темы.
- Один Go-бинарь со встроенным React-фронтендом: один контейнер, один порт.
- Работает без интернета: фронтенд и шрифты лежат внутри бинаря, наружу приложение не ходит.
- Lazy-подключения к источникам и зашифрованные пароли в локальной конфигурации.

## Доступ и безопасность

Kizuna рассчитана на одного пользователя и на свою машину. Аутентификации в ней нет — вместо неё закрытые по умолчанию настройки:

- Порт слушается только на `127.0.0.1` — и в Docker, и при запуске из исходников. Иначе в общей сети (кафе, коворкинг, офис) любой рядом видел бы ваши подключения и выполнял запросы: пароли API расшифровывает сам.
- Запись через API требует заголовок `X-Kizuna-Client`. Так отсекаются запросы, которые чужой сайт делает из вашего браузера. Своим скриптам заголовок нужно слать самим.

Если доступ по сети всё-таки нужен, открывайте порт осознанно и только за прокси с аутентификацией:

```bash
KIZUNA_BIND=0.0.0.0 docker compose up -d   # публикация наружу
KIZUNA_LISTEN=0.0.0.0:9090 go run ./cmd/kizuna   # то же для запуска из исходников
KIZUNA_ALLOWED_HOSTS=kizuna.internal       # если у прокси своё имя хоста
```

## Изменения

История релизов — в [CHANGELOG.md](CHANGELOG.md).

## Лицензия

[Apache 2.0](LICENSE)
