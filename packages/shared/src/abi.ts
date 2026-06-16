/**
 * Hand-curated PoolDawgs ABI — the subset the web app and server use.
 * Mirrors the deployed ChessDawgs template (string gameIds). Regenerate
 * against packages/contracts artifacts if the contract changes.
 */
export const POOL_DAWGS_ABI = [
  // ── views ──
  {
    type: "function",
    name: "games",
    stateMutability: "view",
    inputs: [{ name: "gameId", type: "string" }],
    outputs: [
      { name: "playerOne", type: "address" },
      { name: "playerTwo", type: "address" },
      { name: "isCompleted", type: "bool" },
      { name: "winner", type: "address" },
      { name: "stake", type: "uint256" },
      { name: "rewardClaimed", type: "bool" },
      { name: "exitRequested", type: "bool" },
      { name: "exitRequester", type: "address" },
      { name: "exitRequestTimestamp", type: "uint256" },
      { name: "exitAccepted", type: "bool" },
      { name: "playerOneClaimed", type: "bool" },
      { name: "playerTwoClaimed", type: "bool" },
      { name: "drawCompleted", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "playerPaid",
    stateMutability: "view",
    inputs: [
      { name: "gameId", type: "string" },
      { name: "player", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "rewardToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "DDawgsNFT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "chessDawgsNFT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    // The play gate: holds the PoolDawgs pass OR the grandfathered ChessDawgs NFT.
    type: "function",
    name: "ownsNFT",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "poolAddress",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "companyWallet",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "ABANDONMENT_TIMEOUT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  // ── player actions ──
  {
    type: "function",
    name: "createGame",
    stateMutability: "nonpayable",
    inputs: [
      { name: "stake", type: "uint256" },
      { name: "_gameId", type: "string" },
    ],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "joinGame",
    stateMutability: "nonpayable",
    inputs: [{ name: "gameId", type: "string" }],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelGame",
    stateMutability: "nonpayable",
    inputs: [{ name: "gameId", type: "string" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimReward",
    stateMutability: "nonpayable",
    inputs: [{ name: "gameId", type: "string" }],
    outputs: [],
  },
  {
    // Winner-driven claim with a backend EIP-712 voucher (no settlement tx).
    type: "function",
    name: "claimRewardSigned",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gameId", type: "string" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "resultSigner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "claimDrawReward",
    stateMutability: "nonpayable",
    inputs: [{ name: "gameId", type: "string" }],
    outputs: [],
  },
  // ── backend authority (owner) ──
  {
    type: "function",
    name: "finishGame",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gameId", type: "string" },
      { name: "winner", type: "address" },
    ],
    outputs: [],
  },
  // ── events ──
  {
    type: "event",
    name: "GameCreated",
    inputs: [
      { name: "gameId", type: "string", indexed: false },
      { name: "playerOne", type: "address", indexed: true },
      { name: "stake", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "GameJoined",
    inputs: [
      { name: "gameId", type: "string", indexed: false },
      { name: "playerTwo", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "GameFinished",
    inputs: [
      { name: "gameId", type: "string", indexed: false },
      { name: "winner", type: "address", indexed: false },
      { name: "reward", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "GameCancelled",
    inputs: [
      { name: "gameId", type: "string", indexed: false },
      { name: "playerOne", type: "address", indexed: true },
      { name: "refund", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DrawRewardClaimed",
    inputs: [
      { name: "gameId", type: "string", indexed: false },
      { name: "player", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const ERC721_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
  {
    // ERC721Enumerable — used to find a holder's first token id (may revert if
    // the contract isn't Enumerable; callers fall back to event scanning).
    type: "function",
    name: "tokenOfOwnerByIndex",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Testnet faucet token (MockDDawgsToken) — `mint` is public on testnet only. */
export const FAUCET_TOKEN_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** PoolDawgsNFT — the mintable membership pass (the play gate). */
export const POOL_DAWGS_NFT_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "owns",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
  {
    // Emitted on mint — filter by `to` to find a holder's token id.
    type: "event",
    name: "Minted",
    inputs: [
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;
