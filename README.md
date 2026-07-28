<div align="center">

# 絆 kizuna

<p><strong>Единый веб-интерфейс для PostgreSQL, Redis и Kafka.</strong><br>
Просматривайте данные, работайте с сообщениями и переходите между связанными записями без смены инструментов.</p>

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-f59e0b.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)

Русский · [English](README.en.md)

</div>

## Зачем Kizuna

Kizuna заменяет разрозненный набор из pgAdmin, Redis Desktop Manager и Kafka UI одним компактным приложением. Его цель — сделать ежедневную работу с данными быстрее: открыть таблицу, ключ или сообщение, изменить нужное значение и сразу перейти к связанной сущности в другом источнике.

Это self-hosted приложение для инженеров, аналитиков и команд поддержки. В production оно запускается одним контейнером и не требует отправлять данные во внешний сервис.

## Быстрый старт

```bash
git clone https://github.com/zxchlorka/kizuna.git
cd kizuna
docker compose up -d --build
```

Откройте [http://localhost:9090](http://localhost:9090) и добавьте первое подключение. Конфигурация хранится в Docker-томе `kizuna-data`, а пароли подключений шифруются AES-256-GCM.

<details>
<summary><b>Запуск из исходников</b></summary>

Нужны Go 1.26+ и Node 20+.

```bash
cd frontend && npm install && npm run build && cd ..
go run ./cmd/kizuna
```

Фронтенд встраивается в один Go-бинарь; приложение слушает порт `9090`.

</details>

## Подключения

Подключайте три типа источников в одном мастере: **PostgreSQL**, **Redis** и **Kafka**. Redis поддерживает standalone, Cluster и Sentinel; для Kafka доступны несколько брокеров, SASL и TLS с пользовательским CA bundle.

<p align="center">
  <picture>
    <source srcset=".github/assets/connections-types.webp" type="image/webp">
    <img src=".github/assets/connections-types.png" width="960" alt="Мастер нового подключения с выбором PostgreSQL, Redis и Kafka">
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

<p align="center">
  <img src=".github/assets/sql-console.png" width="960" alt="SQL-консоль Kizuna">
</p>

## Redis — ключи, типы и CLI

Дерево ключей группируется по префиксам. Для String, Hash, List, Set, Sorted Set, Stream и RedisJSON Kizuna открывает подходящий редактор; здесь же доступны TTL, создание ключей и массовые операции.

Встроенный Redis CLI форматирует результат команды и показывает кнопку `open <key>` для распознанного ключа. Например, после `HGETALL profile:1001` можно сразу открыть `profile:1001` в типизированном редакторе — без копирования имени ключа.

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
- Lazy-подключения к источникам и зашифрованные пароли в локальной конфигурации.

## Изменения

История релизов — в [CHANGELOG.md](CHANGELOG.md).

## Лицензия

[Apache 2.0](LICENSE)
