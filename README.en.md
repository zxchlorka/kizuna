<div align="center">

# 絆 kizuna

<p><strong>One web interface for PostgreSQL, Redis, and Kafka.</strong><br>
Browse data, work with messages, and follow related records without switching tools.</p>

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-f59e0b.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)

[Русский](README.md) · English

</div>

## Why Kizuna

Kizuna replaces a scattered set of pgAdmin, Redis Desktop Manager, and Kafka UI with one compact application. Its goal is to make everyday data work faster: open a table, key, or message, change what you need, then jump straight to the related entity in another source.

It is a self-hosted tool for engineers, analysts, and support teams. In production it runs as one container and never sends your data to an external service.

## Quick Start

```bash
git clone https://github.com/zxchlorka/kizuna.git
cd kizuna
docker compose up -d --build
```

Open [http://localhost:9090](http://localhost:9090) and add your first connection. Configuration lives in the `kizuna-data` Docker volume; connection passwords are encrypted with AES-256-GCM.

<details>
<summary><b>Run from source</b></summary>

Requires Go 1.26+ and Node 20+.

```bash
cd frontend && npm install && npm run build && cd ..
go run ./cmd/kizuna
```

The frontend is embedded in one Go binary; the app listens on port `9090`.

</details>

## Connections

Connect all three source types from one wizard: **PostgreSQL**, **Redis**, and **Kafka**. Redis supports standalone, Cluster, and Sentinel; Kafka supports multiple brokers, SASL, and TLS with a custom CA bundle.

<p align="center">
  <picture>
    <source srcset=".github/assets/connections-types.webp" type="image/webp">
    <img src=".github/assets/connections-types.png" width="960" alt="New connection wizard choosing PostgreSQL, Redis, and Kafka">
  </picture>
</p>

## PostgreSQL — from schema to query

Open a schema, table, or view directly from the tree. The table view provides sorting, filters, pagination, column types, and quick foreign-key navigation. Edit mode supports bulk changes, row creation, and deletion, while breadcrumbs retain navigation context.

<p align="center">
  <picture>
    <source srcset=".github/assets/postgres-explorer.webp" type="image/webp">
    <img src=".github/assets/postgres-explorer.png" width="960" alt="Moving from a PostgreSQL schema tree to the orders table and filtering by user_id">
  </picture>
</p>

- SQL console with autocomplete, history, multi-statement scripts, safe `EXPLAIN`, and confirmed `EXPLAIN ANALYZE`.
- DDL actions and an index inspector without switching to another client.
- Forward and reverse foreign keys: jump to a parent row, inspect **Referenced By**, and return through breadcrumbs.

<p align="center">
  <img src=".github/assets/sql-console.png" width="960" alt="Kizuna SQL console">
</p>

## Redis — keys, types, and CLI

The key tree is grouped by prefix. Kizuna opens the right editor for String, Hash, List, Set, Sorted Set, Stream, and RedisJSON; TTL, key creation, and bulk actions stay in the same workspace.

The built-in Redis CLI formats command output and adds an `open <key>` button for a recognized key. After `HGETALL profile:1001`, for example, you can open `profile:1001` in its typed editor immediately—without copying the key name.

<p align="center">
  <picture>
    <source srcset=".github/assets/redis-cli.webp" type="image/webp">
    <img src=".github/assets/redis-cli.png" width="960" alt="Redis CLI runs HGETALL profile:1001 and offers to open that key immediately">
  </picture>
</p>

<p align="center">
  <img src=".github/assets/redis-keys.png" width="960" alt="Typed Redis key view">
</p>

## Kafka — messages and controlled produce

Browse topics, partitions, consumer groups, and JSON messages in one view. Message fields can also drive filters and related-data navigation.

The producer can send one message, a batch of comma-separated JSON objects in **Multi** mode, or a template-expanded batch in **Loop** mode. Before publishing, Kizuna previews every exact message, so you can validate `{{i}}` expressions, step, and count before writing to Kafka.

<p align="center">
  <picture>
    <source srcset=".github/assets/kafka-produce.webp" type="image/webp">
    <img src=".github/assets/kafka-produce.png" width="960" alt="Kafka producer switches between Multi and Loop modes and previews the expanded message batch">
  </picture>
</p>

<p align="center">
  <img src=".github/assets/kafka-messages.png" width="960" alt="Kafka message browser">
</p>

## Cross-source links

The same value lives in three places at once: `user_id` in a Kafka event, the `profile:1008` key in Redis, a column in `public.orders`. Normally that means copying it from window to window. Kizuna lets you describe the jump once.

**Setup takes half a minute.** Right-click a message → **Create link…** → point at the `user_id` field and say it addresses the `profile:*` key in Redis. Done.

**After that it just works.** Right-click any message in that topic and the menu already offers `Redis: profile:1008`. From there the same gesture opens `public.orders` filtered by that same `user_id`. Kizuna builds the filter, the breadcrumb, and the reverse jumps itself — nothing gets copied by hand.

The clip below shows exactly that: the menu is empty, then the jump appears in it.

Links work both ways: an open record shows where to go next and where you came from.

<p align="center">
  <picture>
    <source srcset=".github/assets/cross-source-links.webp" type="image/webp">
    <img src=".github/assets/cross-source-links.png" width="960" alt="Creating a link from a Kafka message, then following it into a Redis profile and PostgreSQL orders">
  </picture>
</p>

<p align="center">
  <img src=".github/assets/links-menu.png" width="960" alt="The links menu on a Redis key: a forward jump into PostgreSQL and reverse jumps back to Kafka and to the orders">
</p>

<p align="center">
  <img src=".github/assets/links-settings.png" width="960" alt="Cross-source link settings">
</p>

## One container

- Dark, light, and system themes.
- One Go binary with the embedded React frontend: one container, one port.
- Works with no internet: the frontend and its fonts ship inside the binary, and the app makes no outbound requests of its own.
- Lazy source connections and encrypted passwords in local configuration.

## Access and security

Kizuna is built for one user on one machine. It has no authentication — closed defaults stand in for it:

- The port listens on `127.0.0.1` only, both in Docker and when run from source. Otherwise anyone on a shared network (cafe, coworking space, office) would see your connections and run queries: the API decrypts stored passwords itself.
- Writes through the API require an `X-Kizuna-Client` header, which blocks requests another site makes from your browser. Your own scripts need to send it themselves.

If you do need network access, open the port deliberately and only behind an authenticating proxy:

```bash
KIZUNA_BIND=0.0.0.0 docker compose up -d   # publish beyond loopback
KIZUNA_LISTEN=0.0.0.0:9090 go run ./cmd/kizuna   # same, running from source
KIZUNA_ALLOWED_HOSTS=kizuna.internal       # if the proxy has its own hostname
```

## Changelog

Release history lives in [CHANGELOG.md](CHANGELOG.md).

## License

[Apache 2.0](LICENSE)
