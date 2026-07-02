<div align="center">

# 絆 kizuna

**One web UI for PostgreSQL, Redis and Kafka — browse, edit and analyze your data.**

Replaces pgAdmin + Redis Desktop Manager + Kafka UI with a single lightweight container.

[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)

English | [Русский](README.ru.md)

![Connections](.github/assets/connections.png)

</div>

## Quick Start

```bash
git clone https://github.com/qsnake66/kizuna.git
cd kizuna
docker compose up -d --build
```

Open **http://localhost:9090** and add your first connection.

Config lives in the `kizuna-data` Docker volume. Connection passwords are encrypted with AES-256-GCM.

<details>
<summary><b>Run from source (without Docker)</b></summary>

Requires Go 1.26+ and Node 20+.

```bash
cd frontend && npm install && npm run build && cd ..
go run ./cmd/kizuna
```

The frontend is embedded into a single Go binary; everything is served on port 9090.

</details>

## Features

### PostgreSQL

![PostgreSQL table view](.github/assets/postgres-table.png)

- Schema tree with tables, views, indexes and row counts
- Browse data with filters, sorting and pagination
- Edit cells inline, add and delete rows — single or bulk
- Follow foreign keys in one click, jump back through breadcrumbs; **Referenced By** opens reverse FKs
- DDL actions and an index inspector

![SQL console](.github/assets/sql-console.png)

- SQL console with autocomplete, multi-statement scripts and query history
- One-click **EXPLAIN** / **EXPLAIN ANALYZE**

### Redis

![Redis key view](.github/assets/redis-keys.png)

- Namespace tree grouped by key prefix
- Typed editors for String, Hash, List and Sorted Set
- TTL management, key creation, bulk operations
- Built-in CLI console

### Kafka

![Kafka message browser](.github/assets/kafka-messages.png)

- Topics with partitions and consumer groups
- Message browser with JSON view and search by message field
- Produce messages right from the UI

### Cross-source links

Link data across sources — a Postgres column to a Redis key pattern, a Kafka message field to a Postgres row — and jump between them in one click. That's the 絆 (kizuna, "bond") the app is named after.

### And also

- Dark / light / system theme
- AES-256-GCM encrypted connection passwords
- Single Go binary with the frontend embedded — one container, one port

## License

[MIT](LICENSE)
