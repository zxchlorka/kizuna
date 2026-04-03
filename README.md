# InfraView

InfraView is a single-binary web app for exploring and editing PostgreSQL data with a focused UI for schema browsing, table data workflows, and safe operational changes.

Current scope is `Phase 1 / PostgreSQL`:

- saved PostgreSQL connections with encrypted passwords
- object tree for schemas, tables, and indexes
- paginated table view with sorting, filters, inline edits, inserts, deletes, and batch save
- DDL flows for create/drop table, add/drop column, and create/drop index
- structured request logging, panic recovery, and audit logging for write operations
- light, dark, and system theme support

## Quick Start

```bash
cp docker-compose.example.yml docker-compose.local.yml
docker compose -f docker-compose.local.yml up -d --build
open http://localhost:9090
```

The app listens on `9090`. PostgreSQL example credentials from the compose file:

- host: `localhost`
- port: `5432`
- database: `devdb`
- username: `dev`
- password: `dev`

## Configuration

InfraView stores runtime config in JSON:

- local default: `./config.json`
- Docker default: `/data/config.json`
- override path with `CONFIG_PATH`

Security notes:

- connection passwords are stored encrypted with `AES-256-GCM`
- do not commit real `config.json` files or production credentials
- use explicit connection tags such as `production` to enable safety warnings in the UI

## Development

Backend:

```bash
make dev-backend
```

Frontend:

```bash
make dev-frontend
```

Checks:

```bash
make test
npm --prefix frontend run lint
npm --prefix frontend run build
```

## Docker

Build the production image:

```bash
docker build -t infraview:latest .
```

Run the packaged app:

```bash
docker run --rm -p 9090:9090 -v "$(pwd)/data:/data" infraview:latest
```

The repository also includes:

- `docker-compose.yml` for local app + postgres + debug flow
- `docker-compose.example.yml` as a clean copyable example for end users

## Screenshots

Key UI surfaces covered in Sprint 3:

- connection list with connection health and settings access
- workspace view with object tree, table tabs, production banner, and DDL controls
- settings page with light/dark/system theme switching

Browser screenshots are intended to be captured during QA runs against the Dockerized app.

## Architecture

High-level request flow:

```text
Browser UI
  -> Chi router / handlers
  -> ConnectionManager (lazy connector lifecycle)
  -> Connector interface
  -> PostgreSQL connector
  -> JSON response
```

Key rules in this repository:

- API handlers stay source-agnostic and always work through `ConnectionManager`
- `internal/connector/connector.go` remains the architectural core
- frontend assets are embedded into the Go binary via `frontend.go`

More details: [docs/CURRENT_ARCHITECTURE.md](docs/CURRENT_ARCHITECTURE.md)

## Roadmap

- Sprint 4: SQL console and `EXPLAIN ANALYZE`
- Phase 2: Redis connector
- Phase 3: Kafka connector
