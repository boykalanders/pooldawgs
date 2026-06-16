import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { POOL_DAWGS_ABI, type Address } from "@pooldawgs/shared";
import type { ServerConfig } from "./config.js";

export interface Relayer {
  /**
   * Sign a win voucher (EIP-712) the winner redeems via claimRewardSigned.
   * The backend never sends a settlement tx — it just signs off-chain, and the
   * contract validates the recovered signer == resultSigner. Null in dev mode.
   */
  signResult(gameId: string, winner: Address): Promise<string | null>;
  /** Legacy owner/operator path: record the winner on-chain. Kept as a backstop. */
  finishGame(gameId: string, winner: Address): Promise<string | null>;
}

const RETRIES = 3;

/**
 * The relayer holds a backend signing key. In the voucher model it is used ONLY
 * to sign Result(gameId, winner) vouchers off-chain (signResult) — it never
 * transacts, so it can be a sealed env key or a KMS key with no on-chain power
 * beyond what the contract grants the matching `resultSigner` address.
 */
export function createRelayer(config: ServerConfig): Relayer {
  // Prefer the dedicated low-privilege operator/signer key; fall back to the
  // owner key for backward-compat.
  const signerKey = config.operatorPrivateKey ?? config.ownerPrivateKey;
  if (!config.chainEnabled || !signerKey) {
    return {
      async signResult(gameId, winner) {
        console.log(`[relayer:dev] signResult(${gameId}, ${winner}) — no chain/key configured`);
        return null;
      },
      async finishGame(gameId, winner) {
        console.log(`[relayer:dev] finishGame(${gameId}, ${winner}) — no chain/key configured`);
        return null;
      },
    };
  }

  const provider = new JsonRpcProvider(config.rpcUrl!);
  const wallet = new Wallet(signerKey, provider);
  console.log(
    `[relayer] signing as ${wallet.address} (${
      config.operatorPrivateKey ? "operator key" : "owner key"
    })`
  );
  const contract = new Contract(config.contractAddress!, POOL_DAWGS_ABI, wallet);

  // EIP-712 domain — MUST match the contract's __EIP712_init("PoolDawgs","1")
  // and the deployed proxy address. chainId is resolved once from the provider.
  let chainIdPromise: Promise<bigint> | null = null;
  const chainId = () => (chainIdPromise ??= provider.getNetwork().then((n) => n.chainId));

  const types = {
    Result: [
      { name: "gameId", type: "string" },
      { name: "winner", type: "address" },
    ],
  };

  return {
    async signResult(gameId, winner) {
      try {
        const domain = {
          name: "PoolDawgs",
          version: "1",
          chainId: await chainId(),
          verifyingContract: config.contractAddress!,
        };
        return await wallet.signTypedData(domain, types, { gameId, winner });
      } catch (error) {
        console.error(`[relayer] signResult(${gameId}) failed`, error);
        return null;
      }
    },

    async finishGame(gameId, winner) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
          const tx = await contract.finishGame(gameId, winner);
          const receipt = await tx.wait();
          console.log(`[relayer] finishGame(${gameId}, ${winner}) tx=${receipt.hash}`);
          return receipt.hash as string;
        } catch (error) {
          lastError = error;
          console.error(`[relayer] finishGame attempt ${attempt}/${RETRIES} failed`, error);
          await new Promise((r) => setTimeout(r, attempt * 2000));
        }
      }
      console.error(`[relayer] PERMANENT FAILURE settling game ${gameId}`, lastError);
      throw lastError;
    },
  };
}
