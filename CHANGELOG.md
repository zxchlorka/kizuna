# Changelog

Notable changes per release. Each heading matches a git tag, so `git show v0.5.0`
gives the same notes from the command line.

## v0.5.1 — 2026-08-03

### Security

- The API refuses requests from web pages the user did not open. State-changing
  calls must carry the `X-Kizuna-Client` header, which forces a preflight no
  foreign page can pass, and only loopback names, bare IP literals, and hosts
  listed in `KIZUNA_ALLOWED_HOSTS` are accepted in `Host` — a rebound DNS name is
  none of those.
- The server binds `127.0.0.1:9090` by default instead of every interface;
  `KIZUNA_LISTEN` overrides it. The image still binds `0.0.0.0` because compose
  publishes the port on loopback only.
- The debug profile publishes its Delve and UI ports on loopback only, and
  compose no longer suggests widening the binding to sit behind a proxy — a
  published backend port is a way around the proxy, not through it.
- Fonts are served from the binary instead of Google Fonts, so a local database
  browser no longer announces every launch to a third party and looks the same
  offline.

### SQL console

- A Stop button cancels the query that is running. A canceled query is reported
  as canceled rather than as a timeout, and can no longer land its results on top
  of the run that replaced it.

### Redis

- Links can be extracted from a selection inside a value, from a member of a
  collection, or from the key itself. The element menu offers per-element and
  selection links, a long value no longer stretches the menu across the screen,
  and a dialog lists every link when there are more than the menu can hold.
- Non-UTF-8 values and CLI replies are shown as hex escapes instead of
  replacement characters, so binary data survives a round trip through the eye.

### Kafka

- Search a topic by whether a field is present at all, independent of its value.
- The topic scan can run unbounded and be canceled at any point, instead of
  stopping when a fixed budget runs out.

### Copy and export

- Query results and table data can be copied or exported as CSV or JSON.
  Duplicate column names survive the JSON export, and TSV headers are escaped.

### Workspace

- Open tabs and SQL drafts are restored after a page reload. Every tab in a
  restored snapshot is validated before it is reopened.
- The connection health cache survives a page load instead of being wiped on
  every one.

## v0.5.0 — 2026-07-27

### Kafka

- Reader optimised: fetches are now sized to the read window, and a full page no
  longer waits out the read budget for straggling partitions. On a real
  54-partition topic this cut the data pulled per page by 56x.
- Browse in both directions with a Newest / Oldest toggle.
- Seek by offset or timestamp, inclusive, in either direction. An offset applies
  to every partition and the UI reports how many it landed in; partitions that do
  not contain it are left out rather than clamped to their nearest edge.
- Field search split into an instant client-side "Filter loaded" and a budgeted
  backend "Search topic", with a JSON field picker built from a sample of the
  messages.
- Fixed duplicated and silently skipped messages in the pagination cursor, and
  recovery from a topic being deleted and recreated under the same name.

### Redis

- Key tree Refresh with stale-while-revalidate.

### Connections and links

- Deleting a connection now cascades to its cross-source links and clears the
  related tab and tree caches.

### Interface

- Consumer group lag is readable at a glance.
- The JSON field picker was rebuilt around aligned columns.

### Documentation

- README walkthroughs reshot as animated WebP: sharper, full colour, and smaller
  than the GIFs they replace.

### HTTP API

- Additive only. `has_newer` / `next_after_offsets` join the existing
  `has_older` / `next_before_offsets`, and `partitions_windowed` was added. No
  existing field changed meaning.

## v0.4.3 — 2026-07-19

- SQL console: statement highlighting, collapsible results, and per-database
  switching.

## v0.4.2 — 2026-07-18

- Fixed the Kafka connection ping and several SQL console bugs.
- Removed the hardcoded version card from the settings page.

## v0.4.1 — 2026-07-16

First tagged release, and the point at which the project became Kizuna. It
already carried the shape the tool has today:

- PostgreSQL, Redis, and Kafka behind one connector interface, added through a
  single connection wizard.
- Cross-source links: describe once how a value points at another system, then
  follow it from a record's context menu.
- SQL console, typed Redis key editors with a built-in CLI, and a Kafka message
  browser with a producer.
- One Go binary with the React frontend embedded, shipped as a single container.

Changes before this tag are not itemised here; see the git history.
