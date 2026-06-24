# Leaderboard & platform stats — data sources

The chain is the source of truth; the database is a rebuildable **index** of
on-chain events. Nothing depends on server memory, so records survive restarts
and redeploys.

## What comes from where

| Panel | Source |
|-------|--------|
| GAMES PLAYED / TOTAL WAGERED / BURNED | **On-chain** — `PoolDawgs.platformStats()` (counters bumped in `finishGame` / `claimRewardSigned`). The chain indexer reads it each poll and the server returns it from `GET /leaderboard`. |
| Ranking (wins / losses / winnings) | **Database** — an indexer ingests `GameFinished` (+ `GameJoined`) events from the contract's deploy block into a persistent store, served from `GET /leaderboard`. Rebuildable from the chain at any time. |

## Database: Postgres → SQLite → memory

`apps/server/src/db/persistence.ts` picks a backend at boot, never crashing:

1. **PostgreSQL** if `DATABASE_URL` is set **and reachable** (driver: `pg`).
2. **SQLite** otherwise — a local file (`SQLITE_PATH`, default `<DATA_DIR>/leaderboard.db`) via Node's built-in `node:sqlite`.
3. **In-memory** only if neither is available (still rebuilt from chain each boot).

The leaderboard loads persisted rows on boot and write-throughs every update.
The indexer persists its last-scanned block (`lb_meta.cursor`) so restarts
resume instead of rescanning.

## Env vars

```
RPC_URL=               # archive-capable RPC (see note) — enables the indexer
CONTRACT_ADDRESS=      # PoolDawgs proxy address (keep stable across redeploys)
CONTRACT_DEPLOY_BLOCK= # block the proxy was deployed at → full-history backfill
DATABASE_URL=          # optional Postgres; omit to use SQLite
SQLITE_PATH=           # optional; defaults to <DATA_DIR>/leaderboard.db
```

> **RPC note:** the full-history backfill issues `getLogs` over old block ranges
> ("archive" requests). Free public RPCs (e.g. publicnode) reject these with
> `403 / "Archive requests require a personal token"`. Use an archive-capable
> endpoint (Alchemy, Infura, an allnodes token, etc.). Without
> `CONTRACT_DEPLOY_BLOCK` the indexer only scans the most recent ~800 blocks.

## Deploying the on-chain counters (proxy upgrade)

`PoolDawgs` is an upgradeable proxy, so the counters are added by **upgrading
the implementation** — the address and all existing games are preserved. The
new counters start at zero and count from the upgrade forward.

1. Upgrade the proxy to the new `PoolDawgs` implementation.
2. (Optional) Seed the pre-upgrade history once: sum the past `GameFinished`
   events (pot = `reward × 1.25`, burn = `reward × 0.125`) and call
   `seedPlatformTotals(games, wagered, burned)` as the owner. It can only be set
   while the totals are still zero.
3. Set `CONTRACT_DEPLOY_BLOCK` so the ranking indexer backfills full history.
