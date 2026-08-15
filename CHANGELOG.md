# Changelog

Notable changes per release. Each heading matches a git tag, so `git show v0.5.0`
gives the same notes from the command line.

## v0.7.0 — 2026-08-16

### Postgres

- New Overview tab: sessions that are running something with the one holding the
  lock named, the workload ordered by total time from pg_stat_statements, tables
  by size next to dead tuples and last autovacuum, replication lag in bytes and
  in time, indexes nothing has read, and sequences measured against the ceiling
  of the column they feed rather than their own max_value.
- A missing extension, or a role that may only read its own statistics, is named
  as such — including which grant reveals the rest. Postgres reports the first as
  an ordinary "relation does not exist" and the second by silently replacing the
  query text, and neither says anything a reader can act on.
- Every section states what its numbers do not cover: statements are counted
  since the last reset, activity is only what the current role may see.
- A pasted connection string fills the form. Both shapes Postgres accepts are
  read, credentials are decoded, and a partial string fills what it has.
- "View row" opens one record vertically, with each column's type and a copy
  button per value, instead of scrolling a wide table sideways.

### Redis

- The Overview lists the cluster's masters with what each one holds, so a node
  filling faster than the others is visible behind the totals.
- A key shows what it occupies in memory, beside its type and TTL.
- A key can be duplicated under a new name, contents and TTL included. Done with
  DUMP and RESTORE rather than Redis's COPY, which requires both keys in the same
  hash slot and so fails for exactly the keys worth duplicating in a cluster.
- A new collection can be created with all of its entries at once rather than one
  and then the rest by hand.

### Kafka

- A topic's Config shows what each setting falls back to without its override,
  and which broker setting to change to move it for every topic at once.

## v0.6.0 — 2026-08-10

### Redis

- New Overview tab per connection: memory against its configured limit, eviction
  policy, key count, uptime, clients and fragmentation. Every figure is a total
  for the connection — in cluster mode the masters are summed and the per-node
  share is shown beside it. Read from one node, a 24-master cluster reported its
  memory twenty-four times low.
- The meter is drawn only against a real ceiling. `maxmemory 0` means Redis
  enforces none, and it says so instead of showing a bar at 0%.
- The key tree is built from one scan instead of one scan per level. Opening a
  namespace costs no request, and a folder's count is the keys actually behind it
  rather than the result of a second, differently budgeted scan.
- `Scan more keys` continues from the cursor and appends, skipping keys an
  earlier page already returned.
- The tree can be filtered by key pattern, matched by `SCAN MATCH` on the server,
  so it finds keys that were never loaded. Plain text is a contains match;
  anything with `*`, `?` or `[` is passed through as a glob.
- Pasting into the key lookup trims surrounding whitespace. Selecting a key with
  the mouse picks up the spacing between cells, so a paste after a typed prefix
  landed as `profile: 1234` and matched nothing.

### Kafka

- New Config tab on a topic: every broker-reported setting with the source that
  set it, so a value chosen on the topic is distinguishable from a default that
  can move underneath it.
- `retention.bytes` is shown as the per-partition limit Kafka enforces, next to
  the topic-wide ceiling it implies — 250 GB on a 12-partition topic bounds the
  topic at 2.73 TiB, not 233 GiB.
- Message search takes several field conditions combined with AND or OR, edited
  in a dialog behind a Filters button. "Filter loaded" and "Search topic" apply
  the same set.
- Double-clicking a row in the field picker uses that field.

### Connections

- Health re-checks itself: every connection is re-tested when the list screen
  opens, then on a 30-second tick while the tab is in the foreground, paused
  while it is hidden. A reload previously always landed inside the cache window,
  so a server that had come back stayed offline until the per-card test button
  was pressed by hand.

### Docs

- The three README walkthrough clips removed in v0.5.2 are reshot on the current
  build, with their static fallbacks refreshed from the same frames.

## v0.5.2 — 2026-08-05

### Cross-source links

- Link menus show what is wired up on the whole connection, not only what
  applies to the open key, table or topic — a couple of entries inline, the full
  list in a dialog. A key with no links of its own no longer looks like a
  connection with none.
- Both ends of a link are named by their connection, so two links between
  same-named tables on different servers are no longer the same line of text.
- A link that points at what is open but cannot be walked back to its source is
  listed as exactly that, instead of being filed under "elsewhere" beside a
  "no links" line about the same object.
- Long menus stay inside the window and scroll instead of running off the edge.

### SQL console

- History is trustworthy after a cancel: a batch is written in one go rather
  than statement by statement, and the console waits for its own run to appear
  instead of reading before the server has finished writing.
- A history refresh that fails no longer repaints a deliberate cancel as a
  failed statement; the panel reports its own error.
- A cancelled batch is reported as a cancelled batch instead of being blamed on
  its first statement.

### Kafka

- A search that fills the match limit exactly, with the log exhausted, is
  reported as a complete result rather than a truncated one.
- Search results are bounded, and a scan step that has been superseded by a
  newer search can no longer write its rows into it.
- The client-side field filter walks JSON paths the same way the backend scan
  does, so "Filter loaded" and "Search topic" agree on what matches.

### Redis

- The value under the cursor for a selection link is read from the value cell
  rather than the whole row, so clicking a field name, index or score no longer
  offers a link built from the wrong text.

### Copy and export

- Copying a selection after a refresh copies what the grid is showing, not the
  values captured when the rows were ticked.
- Copy and export act on every selected row, including rows selected on a page
  that is no longer loaded, and reproduce unsaved edits rather than the stored
  values behind them.
- A column named `__proto__` survives the JSON export, and the CSV formula guard
  is no longer bypassed by leading whitespace.

### Workspace

- A restored tab that was opened by following a foreign key comes back with its
  filters applied, not just with its label saying so.

### Interface

- The last two native dropdowns — the Kafka match operator and the table filter
  operator — render in the app's own palette instead of the operating system's.

### Under the hood

- Roughly 700 lines of unreachable code, duplicated error handling and
  near-identical dialogs removed, along with three unused dependencies. Repeated
  API error unwrapping, request body decoding and confirmation dialogs each
  became one shared piece.

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
