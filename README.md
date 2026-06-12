# PoolDawgs 🎱

Wagered 2D 8-ball pool for the **Deputy Dawgs** ecosystem. Stake **$DDawgs**,
sink the black, take the pot: **80% to the winner, 10% to the company, 10%
burned**. NFT-gated — Deputy Dawgs holders only.

The physics and rules are forked from
[henshmi/Classic-Pool-Game](https://github.com/henshmi/Classic-Pool-Game)
(vendored under `reference/`), rebuilt as a deterministic engine that runs on
**both** the server (authoritative) and the client (rendering/animation).

## Why server-authoritative

Real money is staked, so **the winner can never be decided by a player's
browser**. A trusted backend simulates every shot, enforces turns and the
**4-minute shot clock** (off-chain by design — there is no on-chain timer),
and is the contract `owner`: the only address allowed to call `finishGame`.
Resign = loss. Timeout = forfeit. Win/loss only — the contract's draw
functions are kept for template parity with ChessDawgs but are dormant.

## Layout

```
apps/web/           Next.js frontend — wallet gate, lobby, game view, chat,
                    practice table (local engine), leaderboard
apps/server/        Authoritative game server — Socket.IO rooms, shot clock,
                    chain event listener, relayer (finishGame)
packages/engine/    Deterministic physics + UK-style 8-ball rules (shared)
packages/contracts/ PoolDawgs.sol (UUPS proxy) + Hardhat tests + deploy
packages/shared/    Types, socket event contracts, curated ABI
reference/          Vendored fork source (read-only reference)
```

## Getting started

```bash
pnpm install
pnpm -r build          # builds engine → shared → server, compiles contracts
pnpm -r test           # engine unit tests, server integration tests, contract tests
```

### Run locally — full on-chain stack (recommended)

```bash
# Terminal 1 — local chain
pnpm --filter @pooldawgs/contracts node:local

# Terminal 2 — deploy PoolDawgs + mock $DDawgs/NFT, fund the test wallets
pnpm --filter @pooldawgs/contracts deploy:local
#   → writes local-deployment.json; copy the addresses into
#     apps/server/.env and apps/web/.env.local (templates show the shape;
#     OWNER_PRIVATE_KEY = hardhat account #0 key printed by the node)

# Terminal 3 — game server (chain mode)
pnpm --filter @pooldawgs/server dev

# Terminal 4 — web app (build AFTER the env file exists: NEXT_PUBLIC_* is baked in)
pnpm --filter @pooldawgs/web build && pnpm --filter @pooldawgs/web start
```

Open http://localhost:3000. To play from the browser, add the local network
to MetaMask (RPC `http://127.0.0.1:8545`, chain id `31337`) — the deploy
script funds the client wallet `0x14e9…3Db8` with local ETH, 1M mock
$DDawgs and a gate NFT, and the mock token/NFT addresses are in
`local-deployment.json`.

**Automated proof:** `node apps/server/scripts/e2e-local.mjs` plays a full
wagered game against the running stack — on-chain create/join, signed socket
seating, an authoritative shot, resignation, relayer `finishGame` (real tx),
`claimReward` with the 80/10/10 split asserted on-chain, and the leaderboard
updated.

### Run locally (chain-less dev mode)

Leave `RPC_URL`/`CONTRACT_ADDRESS` empty in `apps/server/.env` and start the
same way — the server runs ad-hoc rooms with no settlement. The **Practice
table** needs no server at all (the Vercel look-and-feel review slice).

### Deploy the contract

```bash
cd packages/contracts
cp .env.example .env   # fill RPC, deployer key, token/NFT/company addresses
pnpm deploy:testnet
```

The deployer key becomes the contract owner **and must be the same key the
server's relayer uses** (`OWNER_PRIVATE_KEY` in `apps/server/.env`). Keep it
in a KMS/secret manager in production.

### Wire up the apps

- `apps/server/.env` — `RPC_URL`, `CONTRACT_ADDRESS`, `OWNER_PRIVATE_KEY`
- `apps/web/.env.local` — `NEXT_PUBLIC_POOLDAWGS_ADDRESS`,
  `NEXT_PUBLIC_DDAWGS_TOKEN_ADDRESS`, `NEXT_PUBLIC_CHAIN_ID`,
  `NEXT_PUBLIC_SERVER_URL`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`

## Controls

- **Aim** — move the mouse (dashed guide + ghost ball; AIM button toggles it)
- **Power** — hold left-click on the table, hold **W**/**S**, or drag the
  right-rail slider
- **Shoot** — release the click/slider, click when power is already set, or
  press **Space**/**Enter**
- **Spin / english** — drag the red dot on the white-ball widget (top =
  follow, bottom = draw, sides = english). Spin is simulated in the shared
  deterministic engine, so the server rules on it — not the client.
- **Ball in hand** — after a foul, click the cloth to place the cue ball
- Sound on/off lives in the ☰ menu (fork's strike/collide/pocket/cushion
  sounds play during shot replays)

## How a wagered game flows

1. Player A: `approve` → `createGame(stake)` (escrows stake, NFT-gated).
2. Player B: `approve` → `joinGame(id)` (escrows stake → game Active).
3. Both connect to the server room (wallet-signature login) and play.
   Clients send `{angle, power}`; the server simulates with the shared
   engine and broadcasts authoritative results; clients re-simulate the
   same shot locally to animate it (deterministic → identical outcome).
4. Game ends (8-ball, resign, or shot-clock timeout) → relayer calls
   `finishGame(id, winner)`.
5. Winner calls `claimReward(id)` → 80/10/10 split. If a winner never
   claims, `ownerWithdrawUnpaid` can sweep after 90 days (UI-bug safety
   net).

## Ecosystem addresses (Ethereum mainnet)

| Contract | Address |
|---|---|
| ChessDawgs (implementation, interface reference) | `0x543bd22deda83bc17c5bb6bbaa98beba5bbb8dd0` |
| $DDawgs ERC-20 (`rewardToken`) | `0x19f78a898f3e3c2f40c6E0CD2EE5545F549d5E99` |
| Gate NFT — ChessDawgsNFT / CDNFT (`DDawgsNFT`) | `0xf82E0cF5605101efE12689461c2bC9392BfDedEF` |

PoolDawgs.sol mirrors the deployed ChessDawgs interface: **string gameIds**
(client-chosen), `poolAddress` = burn destination, `companyWallet`,
`ABANDONMENT_TIMEOUT` (1h) for ignored exit requests and unclaimed-payout
sweeps, and the owner-relayed exit/draw flow.

## Known gaps / open items

- **PoolDawgs proxy + pool/company wallet addresses** — deploy pending
  (rehearse on Sepolia with mock token/NFT, then mainnet).
- **Themed sprite assets** (Dawgs avatars, logos, table art) pending from
  the client; the canvas currently draws the premium theme in vector.
- Lobby/leaderboard stores are in-memory — swap for Postgres/Redis before
  scaling past one server instance.
- Abandoned Active games (both players vanish before any room forms) have
  no automatic refund path; handle operationally or add a contract method.
- Spectating, reconnection grace windows, and quick-match queues are
  minimal/stubbed.
