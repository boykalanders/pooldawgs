// One-off probe: find which chain hosts the ChessDawgs contract, read its
// wiring (NFT, token, pool, company), and check a wallet for the NFT.
import { JsonRpcProvider, Contract, formatUnits } from "ethers";

const CHESS_DAWGS = "0x543bd22deda83bc17c5bb6bbaa98beba5bbb8dd0";
const WALLET = "0x14e9D19c867dA8F304f113F1D4661A8F08593Db8";

const CHAINS = [
  ["Ethereum", "https://ethereum-rpc.publicnode.com"],
  ["BSC", "https://bsc-rpc.publicnode.com"],
  ["Polygon", "https://polygon-bor-rpc.publicnode.com"],
  ["Base", "https://base-rpc.publicnode.com"],
  ["Arbitrum", "https://arbitrum-one-rpc.publicnode.com"],
  ["Avalanche", "https://avalanche-c-chain-rpc.publicnode.com"],
  ["Sepolia", "https://ethereum-sepolia-rpc.publicnode.com"],
  ["BSC testnet", "https://bsc-testnet-rpc.publicnode.com"],
  ["Polygon Amoy", "https://polygon-amoy-bor-rpc.publicnode.com"],
  ["Base Sepolia", "https://base-sepolia-rpc.publicnode.com"],
];

const CHESS_ABI = [
  "function DDawgsNFT() view returns (address)",
  "function rewardToken() view returns (address)",
  "function poolAddress() view returns (address)",
  "function companyWallet() view returns (address)",
  "function owner() view returns (address)",
  "function ABANDONMENT_TIMEOUT() view returns (uint256)",
];

const ERC721_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

for (const [name, rpc] of CHAINS) {
  try {
    const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
    const code = await Promise.race([
      provider.getCode(CHESS_DAWGS),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
    ]);
    if (!code || code === "0x") {
      console.log(`${name}: no contract`);
      continue;
    }
    console.log(`\n=== FOUND on ${name} (${rpc}) — code ${((code.length - 2) / 2)} bytes ===`);
    const chess = new Contract(CHESS_DAWGS, CHESS_ABI, provider);
    const read = async (label, fn) => {
      try {
        console.log(`${label}: ${await fn()}`);
        return await fn();
      } catch (e) {
        console.log(`${label}: <reverted: ${e.shortMessage ?? e.message}>`);
        return null;
      }
    };
    const nftAddr = await read("DDawgsNFT", () => chess.DDawgsNFT());
    const tokenAddr = await read("rewardToken", () => chess.rewardToken());
    await read("poolAddress", () => chess.poolAddress());
    await read("companyWallet", () => chess.companyWallet());
    await read("owner", () => chess.owner());
    await read("ABANDONMENT_TIMEOUT", () => chess.ABANDONMENT_TIMEOUT());

    if (nftAddr) {
      const nft = new Contract(nftAddr, ERC721_ABI, provider);
      try {
        const [nftName, nftSymbol, bal] = await Promise.all([
          nft.name().catch(() => "?"),
          nft.symbol().catch(() => "?"),
          nft.balanceOf(WALLET),
        ]);
        console.log(`NFT ${nftName} (${nftSymbol}) — wallet ${WALLET} holds: ${bal}`);
      } catch (e) {
        console.log(`NFT check failed: ${e.shortMessage ?? e.message}`);
      }
    }
    if (tokenAddr) {
      const token = new Contract(tokenAddr, ERC20_ABI, provider);
      try {
        const [tName, tSymbol, dec, bal] = await Promise.all([
          token.name().catch(() => "?"),
          token.symbol().catch(() => "?"),
          token.decimals().catch(() => 18),
          token.balanceOf(WALLET),
        ]);
        console.log(`Token ${tName} (${tSymbol}) — wallet holds: ${formatUnits(bal, dec)}`);
      } catch (e) {
        console.log(`Token check failed: ${e.shortMessage ?? e.message}`);
      }
    }
  } catch (e) {
    console.log(`${name}: ${e.shortMessage ?? e.message}`);
  }
}
