# Mini Redis

A lightweight Redis-inspired in-memory key-value database built from scratch using **Node.js, TypeScript, TCP, and the Redis Serialization Protocol (RESP)**.

Mini Redis implements a TCP server, Redis-style commands, authentication, TTL expiration, memory limits with LRU eviction, and JSON snapshot persistence. It runs locally or in Docker, and has been deployed on AWS EC2. It is an educational project, not a production replacement for Redis.

## Getting Started

**Prerequisites:** Node.js, npm, Git, and Redis CLI (for interactive testing).

```bash
git clone https://github.com/sakshi1603-gif/MiniRedis.git
cd MiniRedis
npm install

export REDIS_PASSWORD="your-password"
export PORT=6391
export MAXMEMORY=64mb
export SNAPSHOT_PATH=./dump.json

npm start
```

Windows PowerShell:

```powershell
$env:REDIS_PASSWORD = "your-password"
$env:PORT = "6391"
$env:MAXMEMORY = "64mb"
$env:SNAPSHOT_PATH = "./dump.json"

npm start
```

In another terminal:

```bash
redis-cli -h 127.0.0.1 -p 6391
```

```redis
AUTH your-password
PING
SET name sakshi
GET name
SET session active EX 10
TTL session
DEL name
INFO
```

### Environment variables

| Variable | Description | Default / behaviour |
|---|---|---|
| `REDIS_PASSWORD` | Authentication password | Required; server exits if missing or empty |
| `PORT` | TCP server port | `6379` |
| `MAXMEMORY` | Memory limit, e.g. `64mb`, `512kb`, `4096` | Unset or `0` means unlimited |
| `SNAPSHOT_PATH` | Snapshot file location | `./dump.json` |
| `DEBUG` | Logs parsed commands when set to a non-empty value | Disabled |

Supported memory units: bytes, `kb`, `mb`, `gb` (case-insensitive; 1 KB = 1024 bytes).

## Features

- **TCP server** using Node.js `net`.
- **RESP parsing** with fragmented TCP input and pipelined commands.
- **Authentication:** `AUTH` with per-connection state; SHA-256 digests compared with `timingSafeEqual`.
- **Input protection:** protocol limits, plus stricter limits before authentication.
- **Key-value storage** for string keys and values using JavaScript `Map`.
- **TTL expiration:** lazy plus sampled active expiration.
- **Memory limit with LRU eviction** (hash map + doubly linked list).
- **JSON snapshot persistence** with atomic rename and recovery on startup.
- **Automatic snapshots** based on elapsed time and change count.
- **Graceful shutdown** on `SIGINT`/`SIGTERM` with a final save.
- **Docker** deployment with a persistent volume; deployed on AWS EC2.

## Technology Stack

| Category | Technology |
|---|---|
| Runtime / language | Node.js, TypeScript |
| Networking / protocol | TCP (`net`), RESP |
| Storage | JavaScript `Map` |
| LRU index | `Map` + doubly linked list |
| Persistence | JSON snapshots |
| Testing | Vitest |
| Deployment | Docker, AWS EC2 |

## Architecture

```text
Redis Client → TCP Server → RESP Parser → Authentication Check
             → Command Handler → In-Memory Store → RESP Response → Client
```

```text
In-Memory Store ─┬─ TTL Manager ── Active Expiration
                 └─ Memory Manager ── LRU Index (doubly linked list)

Snapshot Scheduler → Persistence Layer → JSON Snapshot → Recovery on startup
```

The server parses the RESP command before checking authentication because it must understand `AUTH` before it can authenticate a connection. Persistence is a separate supporting flow, not a step that runs after LRU eviction.

## Supported Commands

| Command | Description | Example |
|---|---|---|
| `AUTH` | Authenticate a connection | `AUTH password` |
| `PING` | Check server availability | `PING` |
| `SET` | Store a key-value pair | `SET name sakshi` |
| `SET ... EX` | Store with expiration | `SET session active EX 10` |
| `GET` | Retrieve a value | `GET name` |
| `DEL` | Delete one or more keys | `DEL name` |
| `EXISTS` | Check whether keys exist | `EXISTS name` |
| `EXPIRE` | Set expiration time | `EXPIRE session 10` |
| `TTL` | Remaining expiration time | `TTL session` |
| `INFO` | Memory and statistics (default, `memory`, and `stats` sections) | `INFO` |
| `CONFIG GET` | Supports `maxmemory` | `CONFIG GET maxmemory` |
| `SAVE` | Save a snapshot synchronously | `SAVE` |
| `BGSAVE` | Request a save through the scheduler | `BGSAVE` |

`TTL` returns `-2` if the key doesn't exist, `-1` if it has no expiration, otherwise the remaining seconds. This is a limited Redis-style command set, not full compatibility.

## How It Works

### RESP and TCP stream handling

The parser handles simple strings, errors, integers, bulk strings, and arrays. TCP is a byte stream, so it also handles incomplete commands split across writes and multiple commands in one write, and it waits when a value hasn't fully arrived. It validates integers, bulk-string lengths, array lengths, and nesting depth.

### Storage and TTL

Entries live in a JavaScript `Map`, each holding a value and an expiration timestamp (or `null`).

- **Lazy expiration:** an expired key is removed when accessed.
- **Active expiration:** a sweeper samples keys that have TTLs: 100 ms default interval, batches of up to 20 keys, up to 10 rounds per sweep. Cleanup is incremental, not an immediate full scan.

### Memory management and LRU eviction

Usage is estimated per entry as:

```text
UTF-8 key size + UTF-8 value size + 64 bytes estimated overhead
```

This is an application-level estimate, not Node.js process memory.

A `Map` locates list nodes and a doubly linked list keeps usage order: head is most recently used, tail is least recently used. Accessed or written keys move to the head. When the limit is exceeded, the tail key is evicted. A limit of `0` means unlimited and no eviction.

**Automated LRU tests verify that:**

1. A full store evicts the least recently used key.
2. `GET` updates a key's usage order.
3. `EXISTS` updates a key's usage order.
4. Recently accessed keys survive subsequent insertions.
5. TTL metadata access does not update LRU order.
6. Deletion and expiration release accounted memory.

### Snapshot persistence

A snapshot holds a format version, creation timestamp, live entries, and absolute expiration timestamps (epoch milliseconds).

Saving: build the snapshot → serialize to JSON → write a temporary file → rename it to the snapshot path. On startup the snapshot is validated and loaded, expired entries are skipped, and the memory limit is applied. The temp-file-and-rename approach reduces the risk of a partially written final file; it is not an `fsync` durability guarantee.

**Scheduler:** default rules are `[60 s, 1 change]` and `[10 s, 100 changes]`, checked every second. It prevents overlapping saves, tracks changes made during a save, and supports a final save on shutdown.

**Implementation note:** the scheduler exposes an asynchronous interface, but persistence uses `writeFileSync` and `renameSync`, so snapshot writing can block the event loop. `BGSAVE` does not fork or use a worker thread and is not equivalent to Redis's background save.

## Authentication and Input Protection

`REDIS_PASSWORD` is required. The server hashes the configured password and each submitted password with SHA-256 and compares the fixed-length digests with `timingSafeEqual`. Authentication state is per connection.

| Input | Limit |
|---|---:|
| Unauthenticated buffered input | 64 KiB |
| Unauthenticated bulk strings | 64 KiB |
| Authenticated bulk strings | 64 MiB |
| RESP line length | 64 KiB |
| RESP nesting depth | 32 |
| RESP array elements | 1,048,576 |

The bulk-string limit also applies recursively to array elements. If an unauthenticated connection exceeds the buffer limit, the server rejects the input and closes the connection, so **send `AUTH` as its own message** before large requests.

After authentication there is no total per-connection input-buffer limit; only the per-structure limits above apply. SHA-256 is a cryptographic hash, not a password-specific hashing algorithm, and these measures don't make the server production-secure.

## Testing

```bash
npm test
npx tsc --noEmit
```

| Metric | Result |
|---|---:|
| Test files passed | 9 |
| Tests passed | 87 |
| Tests skipped | 1 |
| Tests failed | 0 |
| Duration | 7.19 s |

The skipped test is a SIGTERM-related test, skipped on Windows because of platform-specific signal behaviour. Persistence across a Docker container restart was verified separately on EC2.

Coverage: commands, storage, TTL, memory management, LRU eviction, snapshot persistence and scheduling, TCP communication, authentication, input limits, pipelining, and fragmented TCP writes. Run `npm test` on your checkout to verify.

## Docker

The Dockerfile is based on `node:22-bookworm-slim`.

```bash
docker build -t mini-redis:v2 .
docker volume create mini-redis-data

read -s -p "Redis password: " REDIS_PASSWORD
echo

docker run -d \
  --name mini-redis \
  -p 127.0.0.1:6391:6391 \
  -v mini-redis-data:/data \
  -e MAXMEMORY=64mb \
  -e REDIS_PASSWORD="$REDIS_PASSWORD" \
  mini-redis:v2

unset REDIS_PASSWORD
```

Container port `6391`, snapshot path `/data/dump.json`, volume `mini-redis-data`. `REDIS_PASSWORD` is required even though the Dockerfile doesn't set it. Use `sudo` if your user can't access the Docker daemon.

Useful commands: `docker ps`, `docker logs -f mini-redis`, `docker stop|start|restart mini-redis`, `docker stats`.

The named volume keeps snapshot data across container removal and recreation. Don't remove it if you want to keep the data.

Publishing on `127.0.0.1:6391:6391` binds the host side to localhost, so the service isn't reachable through the machine's public IP. Access is local or through an SSH tunnel.

## AWS EC2 Deployment

| Component | Deployment |
|---|---|
| Service | AWS EC2, Ubuntu 24.04, `t3.micro` |
| Runtime | Docker, image `mini-redis:v2` |
| Application port | `6391` (localhost only) |

Access from your laptop with an SSH tunnel, so the Redis port is never exposed to the internet:

```bash
ssh -i path/to/your-key.pem \
  -L 6391:127.0.0.1:6391 \
  ubuntu@YOUR_EC2_PUBLIC_IP
```

Keep the session open, then in another terminal run `redis-cli -h 127.0.0.1 -p 6391` and `AUTH your-password`. The first port in `-L` is your laptop's local port; the destination is interpreted from the EC2 machine's side.

### Deployment verification

Tested through `redis-cli` on the deployed instance:

| Test | Command | Result |
|---|---|---|
| Server response | `PING` | `PONG` |
| Store / retrieve | `SET name sakshi`, `GET name` | `OK`, `"sakshi"` |
| Existing / missing key | `EXISTS name`, `EXISTS unknown` | `1`, `0` |
| Delete | `DEL name`, then `GET name` | `1`, `(nil)` |
| Expiration | `EXPIRE session 10`, `TTL session` | `1`, `3` in one check |
| Expired read | `GET session` | `(nil)` |
| Unauthenticated command | any command before `AUTH` | `NOAUTH` |

## Benchmarks

Measured with `redis-benchmark` 7.0.15 on the same EC2 `t3.micro` (2 vCPUs, ~909 MiB RAM) that hosts the server, over localhost. The client and server share CPU, and t3 CPU is burstable, so results can vary.

> These results were measured on the baseline image, before the latest security changes (pre-authentication input limits and SHA-256 comparison) were rebuilt and deployed.

### SET and GET

50 clients, 100,000 requests per operation, 3-byte payload, 64 MiB memory limit.

| Operation | Throughput | Average latency | p95 | p99 |
|---|---:|---:|---:|---:|
| SET | 19,124.12 req/s | 2.521 ms | 4.535 ms | 6.599 ms |
| GET | 20,673.97 req/s | 2.325 ms | 4.071 ms | 5.223 ms |

All requests completed, with no evictions during the run.

```bash
redis-benchmark -h 127.0.0.1 -p 6391 -a "$REDIS_PASSWORD" -t set -n 100000 -c 50 -d 3
redis-benchmark -h 127.0.0.1 -p 6391 -a "$REDIS_PASSWORD" -t get -n 100000 -c 50 -d 3
```

### Pipelined `PING_MBULK`

A separate workload, so don't compare it directly with SET/GET. 10,000 requests, 50 clients, pipeline depth 16, 3-byte payload.

| Metric | Result |
|---|---:|
| Throughput | 19,230.77 req/s |
| Average latency | 2.039 ms |
| Minimum / p50 | 0.112 ms / 0.327 ms |
| p95 / p99 | 16.639 ms / 34.783 ms |
| Maximum | 38.911 ms |

```bash
redis-benchmark -h 127.0.0.1 -p 6391 -a "$REDIS_PASSWORD" -t ping_mbulk -n 10000 -c 50 -P 16
```

All requests completed. This was a short run (about 0.5 s) and throughput was not higher than the unpipelined runs, so no pipelining speedup is claimed. Pipelined correctness is covered by the automated tests. The tool printed a warning that it couldn't fetch the server's `CONFIG`; it didn't affect the run.

These are single-instance results for specific workloads, not a comparison with production Redis.

## Memory Eviction Experiment

Run on EC2 in a fresh temporary container with an empty database (`keys:0`): 1 MiB limit, 1,000 keys inserted with 4 KiB values, policy `allkeys-lru`.

| Metric | Result |
|---|---:|
| Configured memory limit | 1,048,576 bytes |
| Final estimated memory usage | 1,045,918 bytes |
| Keys inserted | 1,000 |
| Keys evicted | 749 |
| Keys remaining | 251 |

Evicted plus remaining equals keys inserted. The experiment shows that eviction triggers and that usage stays within the limit; victim ordering is covered by the automated LRU tests above. Usage is the application's estimate, not measured process memory.

## Project Structure

```text
MiniRedis/
├── src/
│   ├── server.ts
│   ├── commands/
│   │   ├── commands.ts
│   │   ├── commands.test.ts
│   │   └── commands-memory.test.ts
│   ├── protocol/
│   │   ├── resp.ts
│   │   └── encode.ts
│   ├── store/
│   │   ├── store.ts
│   │   ├── memory-manager.ts
│   │   ├── lru.ts
│   │   ├── store.test.ts
│   │   ├── store-memory.test.ts
│   │   └── memory.test.ts
│   └── persistence/
│       ├── persistence.ts
│       ├── snapshotScheduler.ts
│       ├── persistence.test.ts
│       └── snapshotScheduler.test.ts
├── test/
│   ├── e2e.test.ts
│   └── shutdown.test.ts
├── Dockerfile
├── .dockerignore
├── package.json
├── package-lock.json
├── tsconfig.json
└── LICENSE
```

Unit tests sit next to the modules they test; end-to-end and shutdown tests live in `test/`.

## Limitations

- Limited Redis command and protocol compatibility.
- No lists, hashes, sets, sorted sets, transactions, replication, or clustering.
- Values are UTF-8 strings; bulk strings are not binary-safe.
- JSON snapshots only: no AOF or WAL, so writes after the last snapshot can be lost on abrupt termination.
- No `fsync`, so atomic rename doesn't guarantee durability after a power loss or OS crash.
- Snapshot filesystem operations are synchronous and can block the event loop; `BGSAVE` doesn't fork or use a worker.
- Authenticated clients can send bulk strings up to 64 MiB, with no total per-connection input-buffer limit after authentication.
- Memory accounting is an estimate, not process memory.
- No TLS, no ACLs, no authentication rate limiting.
- Benchmarks come from a limited single-instance workload.

Don't expose the service directly to the public internet; authentication alone doesn't encrypt traffic.

## Future Improvements

- AOF persistence with configurable fsync policies.
- Non-blocking snapshot writing (worker thread or child process).
- Binary-safe protocol and value handling.
- Per-connection input-buffer limits after authentication.
- Authentication rate limiting and TLS.
- More commands and data structures (`INCR`, `SCAN`, ...).
- More accurate memory accounting.
- Broader load testing, including pipelined `SET`/`GET`, and compatibility testing with Redis clients.

## License

MIT. See [LICENSE](LICENSE).
