import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  PoolDawgs,
  PoolDawgsNFT,
  MockDDawgsToken,
  MockDDawgsNFT,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const STAKE = ethers.parseEther("100");
const POT = STAKE * 2n;
const WINNER_SHARE = (POT * 80n) / 100n;
const COMPANY_SHARE = (POT * 10n) / 100n;
const BURN_SHARE = (POT * 10n) / 100n;
const GAME_ID = "pool-game-001";
const ABANDONMENT_TIMEOUT = 3600;

describe("PoolDawgs", () => {
  let pool: PoolDawgs;
  let token: MockDDawgsToken;
  let nft: PoolDawgsNFT; // PoolDawgs membership pass (gate)
  let chessNft: MockDDawgsNFT; // grandfathered ChessDawgs NFT
  let owner: HardhatEthersSigner; // backend relayer / deployer
  let p1: HardhatEthersSigner;
  let p2: HardhatEthersSigner;
  let outsider: HardhatEthersSigner; // no NFT at all
  let chessHolder: HardhatEthersSigner; // only the ChessDawgs NFT
  let company: HardhatEthersSigner;
  let burnPool: HardhatEthersSigner;

  beforeEach(async () => {
    [owner, p1, p2, outsider, chessHolder, company, burnPool] = await ethers.getSigners();

    token = await (await ethers.getContractFactory("MockDDawgsToken")).deploy();
    nft = await (await ethers.getContractFactory("PoolDawgsNFT")).deploy("");
    chessNft = await (await ethers.getContractFactory("MockDDawgsNFT")).deploy();

    const PoolDawgsFactory = await ethers.getContractFactory("PoolDawgs");
    pool = (await upgrades.deployProxy(
      PoolDawgsFactory,
      [
        await token.getAddress(),
        await nft.getAddress(),
        await chessNft.getAddress(),
        burnPool.address,
        company.address,
      ],
      { kind: "transparent" }
    )) as unknown as PoolDawgs;

    for (const player of [p1, p2]) {
      await token.mint(player.address, STAKE * 10n);
      await token.connect(player).approve(await pool.getAddress(), ethers.MaxUint256);
      await nft.connect(player).mint(); // mint a PoolDawgs pass
    }
    // outsider has tokens but no NFT of either kind
    await token.mint(outsider.address, STAKE * 10n);
    await token.connect(outsider).approve(await pool.getAddress(), ethers.MaxUint256);
    // chessHolder has tokens + only a ChessDawgs NFT (the exception)
    await token.mint(chessHolder.address, STAKE * 10n);
    await token.connect(chessHolder).approve(await pool.getAddress(), ethers.MaxUint256);
    await chessNft.mint(chessHolder.address);
  });

  async function createAndJoin(gameId = GAME_ID): Promise<string> {
    await pool.connect(p1).createGame(STAKE, gameId);
    await pool.connect(p2).joinGame(gameId);
    return gameId;
  }

  describe("full game: create → join → finish → claim", () => {
    it("escrows both stakes and pays 80/10/10 on claim", async () => {
      await createAndJoin();
      expect(await token.balanceOf(await pool.getAddress())).to.equal(POT);

      await expect(pool.connect(owner).finishGame(GAME_ID, p1.address))
        .to.emit(pool, "GameFinished")
        .withArgs(GAME_ID, p1.address, WINNER_SHARE);

      const before = await token.balanceOf(p1.address);
      await pool.connect(p1).claimReward(GAME_ID);

      expect((await token.balanceOf(p1.address)) - before).to.equal(WINNER_SHARE);
      expect(await token.balanceOf(company.address)).to.equal(COMPANY_SHARE);
      expect(await token.balanceOf(burnPool.address)).to.equal(BURN_SHARE);
      expect(await token.balanceOf(await pool.getAddress())).to.equal(0n);
      expect(await pool.playerPaid(GAME_ID, p1.address)).to.equal(true);
    });

    it("rejects double-claim", async () => {
      await createAndJoin();
      await pool.connect(owner).finishGame(GAME_ID, p1.address);
      await pool.connect(p1).claimReward(GAME_ID);
      await expect(pool.connect(p1).claimReward(GAME_ID)).to.be.revertedWith(
        "already claimed"
      );
    });

    it("only the winner can claim", async () => {
      await createAndJoin();
      await pool.connect(owner).finishGame(GAME_ID, p1.address);
      await expect(pool.connect(p2).claimReward(GAME_ID)).to.be.revertedWith(
        "not the winner"
      );
    });

    it("non-owner/non-operator cannot finishGame (the chain trusts only the backend)", async () => {
      await createAndJoin();
      await expect(
        pool.connect(p1).finishGame(GAME_ID, p1.address)
      ).to.be.revertedWith("not authorized");
    });

    it("a dedicated operator may settle, but not touch admin functions", async () => {
      await createAndJoin();
      // Owner appoints outsider as the low-privilege operator.
      await pool.connect(owner).setOperator(outsider.address);
      // Operator can finish the game…
      await pool.connect(outsider).finishGame(GAME_ID, p1.address);
      const g = await pool.games(GAME_ID);
      expect(g.isCompleted).to.equal(true);
      expect(g.winner).to.equal(p1.address);
      // …but cannot use owner-only admin powers.
      await expect(
        pool.connect(outsider).setCompanyWallet(outsider.address)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
      await expect(
        pool.connect(outsider).setOperator(p1.address)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("winner must be a player of the game", async () => {
      await createAndJoin();
      await expect(
        pool.connect(owner).finishGame(GAME_ID, outsider.address)
      ).to.be.revertedWith("winner not a player");
    });

    it("winner self-claims with a backend voucher (no settlement tx)", async () => {
      await createAndJoin();
      // The backend signer is set on-chain; the backend never sends a tx.
      await pool.connect(owner).setResultSigner(company.address);
      const domain = {
        name: "PoolDawgs",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await pool.getAddress(),
      };
      const types = {
        Result: [
          { name: "gameId", type: "string" },
          { name: "winner", type: "address" },
        ],
      };
      const voucher = await company.signTypedData(domain, types, {
        gameId: GAME_ID,
        winner: p1.address,
      });

      const before = await token.balanceOf(p1.address);
      await pool.connect(p1).claimRewardSigned(GAME_ID, voucher);
      const g = await pool.games(GAME_ID);
      expect(g.isCompleted).to.equal(true);
      expect(g.winner).to.equal(p1.address);
      expect(g.rewardClaimed).to.equal(true);
      expect((await token.balanceOf(p1.address)) - before).to.equal(WINNER_SHARE);

      // A voucher signed by anyone but the resultSigner is rejected.
      await pool.connect(p1).createGame(STAKE, "vouch-2");
      await pool.connect(p2).joinGame("vouch-2");
      const forged = await outsider.signTypedData(domain, types, {
        gameId: "vouch-2",
        winner: p1.address,
      });
      await expect(
        pool.connect(p1).claimRewardSigned("vouch-2", forged)
      ).to.be.revertedWith("bad voucher");
    });

    it("cannot finish a game twice or before it is full", async () => {
      await pool.connect(p1).createGame(STAKE, GAME_ID);
      await expect(
        pool.connect(owner).finishGame(GAME_ID, p1.address)
      ).to.be.revertedWith("game not active");

      await pool.connect(p2).joinGame(GAME_ID);
      await pool.connect(owner).finishGame(GAME_ID, p1.address);
      await expect(
        pool.connect(owner).finishGame(GAME_ID, p2.address)
      ).to.be.revertedWith("game completed");
    });
  });

  describe("gating and creation rules", () => {
    it("rejects create/join without any Dawgs NFT", async () => {
      await expect(
        pool.connect(outsider).createGame(STAKE, GAME_ID)
      ).to.be.revertedWith("must own a Dawgs NFT");

      await pool.connect(p1).createGame(STAKE, GAME_ID);
      await expect(pool.connect(outsider).joinGame(GAME_ID)).to.be.revertedWith(
        "must own a Dawgs NFT"
      );
    });

    it("ownsNFT reflects pool pass, chess grandfather, and neither", async () => {
      expect(await pool.ownsNFT(p1.address)).to.equal(true); // pool pass
      expect(await pool.ownsNFT(chessHolder.address)).to.equal(true); // grandfathered
      expect(await pool.ownsNFT(outsider.address)).to.equal(false); // neither
    });

    it("a ChessDawgs-NFT holder may play without a PoolDawgs pass", async () => {
      // chessHolder has no PoolDawgs pass, only the ChessDawgs NFT.
      expect(await nft.balanceOf(chessHolder.address)).to.equal(0n);
      await expect(pool.connect(chessHolder).createGame(STAKE, GAME_ID)).to.emit(
        pool,
        "GameCreated"
      );
      await expect(pool.connect(p1).joinGame(GAME_ID)).to.emit(pool, "GameJoined");
    });

    it("minting a PoolDawgs pass unlocks play; the pass mints one per wallet", async () => {
      await expect(pool.connect(outsider).createGame(STAKE, GAME_ID)).to.be.revertedWith(
        "must own a Dawgs NFT"
      );
      await nft.connect(outsider).mint();
      expect(await pool.ownsNFT(outsider.address)).to.equal(true);
      await expect(pool.connect(outsider).createGame(STAKE, GAME_ID)).to.emit(
        pool,
        "GameCreated"
      );
      await expect(nft.connect(outsider).mint()).to.be.revertedWith("already minted");
    });

    it("owner can clear the grandfather exception", async () => {
      await pool.connect(owner).setChessDawgsNFT(ethers.ZeroAddress);
      expect(await pool.ownsNFT(chessHolder.address)).to.equal(false);
    });

    it("rejects zero stake, empty/duplicate gameId, and self-join", async () => {
      await expect(pool.connect(p1).createGame(0, GAME_ID)).to.be.revertedWith(
        "zero stake"
      );
      await expect(pool.connect(p1).createGame(STAKE, "")).to.be.revertedWith(
        "empty gameId"
      );
      await pool.connect(p1).createGame(STAKE, GAME_ID);
      await expect(
        pool.connect(p2).createGame(STAKE, GAME_ID)
      ).to.be.revertedWith("gameId taken");
      await expect(pool.connect(p1).joinGame(GAME_ID)).to.be.revertedWith(
        "cannot play yourself"
      );
    });
  });

  describe("cancel", () => {
    it("refunds the creator before anyone joins and frees the gameId", async () => {
      await pool.connect(p1).createGame(STAKE, GAME_ID);
      const before = await token.balanceOf(p1.address);
      await expect(pool.connect(p1).cancelGame(GAME_ID))
        .to.emit(pool, "GameCancelled")
        .withArgs(GAME_ID, p1.address, STAKE);
      expect((await token.balanceOf(p1.address)) - before).to.equal(STAKE);

      // Deleted game frees the id for reuse.
      await pool.connect(p2).createGame(STAKE, GAME_ID);
    });

    it("cannot cancel after an opponent joined", async () => {
      await createAndJoin();
      await expect(pool.connect(p1).cancelGame(GAME_ID)).to.be.revertedWith(
        "opponent joined"
      );
    });

    it("only the creator can cancel", async () => {
      await pool.connect(p1).createGame(STAKE, GAME_ID);
      await expect(pool.connect(p2).cancelGame(GAME_ID)).to.be.revertedWith(
        "not your game"
      );
    });
  });

  describe("dormant exit/draw flow (ChessDawgs template parity)", () => {
    it("request → accept → drawGame splits the pot 40/40/10/10", async () => {
      await createAndJoin();

      await expect(pool.connect(owner).ownerRequestExitGame(GAME_ID, p1.address))
        .to.emit(pool, "ExitRequested")
        .withArgs(GAME_ID, p1.address);
      await expect(pool.connect(owner).ownerAcceptExitRequest(GAME_ID, p2.address))
        .to.emit(pool, "ExitRequestAccepted")
        .withArgs(GAME_ID, p2.address);
      await expect(pool.connect(owner).drawGame(GAME_ID, p1.address))
        .to.emit(pool, "GameExited")
        .withArgs(GAME_ID, COMPANY_SHARE, BURN_SHARE);

      const half = WINNER_SHARE / 2n;
      const p1Before = await token.balanceOf(p1.address);
      const p2Before = await token.balanceOf(p2.address);
      await expect(pool.connect(p1).claimDrawReward(GAME_ID))
        .to.emit(pool, "DrawRewardClaimed")
        .withArgs(GAME_ID, p1.address, half);
      await pool.connect(p2).claimDrawReward(GAME_ID);

      expect((await token.balanceOf(p1.address)) - p1Before).to.equal(half);
      expect((await token.balanceOf(p2.address)) - p2Before).to.equal(half);
      expect(await token.balanceOf(company.address)).to.equal(COMPANY_SHARE);
      expect(await token.balanceOf(burnPool.address)).to.equal(BURN_SHARE);
      expect(await token.balanceOf(await pool.getAddress())).to.equal(0n);
    });

    it("rejected requests reset the exit state", async () => {
      await createAndJoin();
      await pool.connect(owner).ownerRequestExitGame(GAME_ID, p1.address);
      await pool.connect(owner).ownerRejectExitRequest(GAME_ID, p2.address);
      await expect(
        pool.connect(owner).drawGame(GAME_ID, p1.address)
      ).to.be.revertedWith("no matching request");
      // A fresh request is allowed after rejection.
      await pool.connect(owner).ownerRequestExitGame(GAME_ID, p2.address);
    });

    it("an ignored request can be drawn only after ABANDONMENT_TIMEOUT", async () => {
      await createAndJoin();
      await pool.connect(owner).ownerRequestExitGame(GAME_ID, p1.address);
      await expect(
        pool.connect(owner).drawGame(GAME_ID, p1.address)
      ).to.be.revertedWith("not accepted nor abandoned");

      await time.increase(ABANDONMENT_TIMEOUT + 1);
      await pool.connect(owner).drawGame(GAME_ID, p1.address);
    });

    it("draw claims cannot be repeated and outsiders cannot claim", async () => {
      await createAndJoin();
      await pool.connect(owner).ownerRequestExitGame(GAME_ID, p1.address);
      await pool.connect(owner).ownerAcceptExitRequest(GAME_ID, p2.address);
      await pool.connect(owner).drawGame(GAME_ID, p1.address);

      await pool.connect(p1).claimDrawReward(GAME_ID);
      await expect(pool.connect(p1).claimDrawReward(GAME_ID)).to.be.revertedWith(
        "already claimed"
      );
      await expect(pool.connect(outsider).claimDrawReward(GAME_ID)).to.be.revertedWith(
        "not a player"
      );
    });

    it("accepter must be the opponent of the requester", async () => {
      await createAndJoin();
      await pool.connect(owner).ownerRequestExitGame(GAME_ID, p1.address);
      await expect(
        pool.connect(owner).ownerAcceptExitRequest(GAME_ID, p1.address)
      ).to.be.revertedWith("accepter must be the opponent");
    });
  });

  describe("ownerWithdrawUnpaid safety net", () => {
    it("sweeps an unclaimed win to the company only after the timeout", async () => {
      await createAndJoin();
      await pool.connect(owner).finishGame(GAME_ID, p1.address);

      await expect(
        pool.connect(owner).ownerWithdrawUnpaid(GAME_ID, p1.address)
      ).to.be.revertedWith("claim window open");

      await time.increase(ABANDONMENT_TIMEOUT + 1);
      await expect(pool.connect(owner).ownerWithdrawUnpaid(GAME_ID, p1.address))
        .to.emit(pool, "OwnerWithdrawal")
        .withArgs(GAME_ID, p1.address, WINNER_SHARE + COMPANY_SHARE);

      // Burn still happens; winner+company shares land at the company wallet.
      expect(await token.balanceOf(burnPool.address)).to.equal(BURN_SHARE);
      expect(await token.balanceOf(company.address)).to.equal(
        WINNER_SHARE + COMPANY_SHARE
      );
      expect(await token.balanceOf(await pool.getAddress())).to.equal(0n);
    });

    it("cannot sweep a pot the winner already claimed", async () => {
      await createAndJoin();
      await pool.connect(owner).finishGame(GAME_ID, p1.address);
      await pool.connect(p1).claimReward(GAME_ID);
      await time.increase(ABANDONMENT_TIMEOUT + 1);
      await expect(
        pool.connect(owner).ownerWithdrawUnpaid(GAME_ID, p1.address)
      ).to.be.revertedWith("already paid");
    });

    it("sweeps an unclaimed draw share after the timeout", async () => {
      await createAndJoin();
      await pool.connect(owner).ownerRequestExitGame(GAME_ID, p1.address);
      await pool.connect(owner).ownerAcceptExitRequest(GAME_ID, p2.address);
      await pool.connect(owner).drawGame(GAME_ID, p1.address);
      await pool.connect(p1).claimDrawReward(GAME_ID);

      await time.increase(ABANDONMENT_TIMEOUT + 1);
      await pool.connect(owner).ownerWithdrawUnpaid(GAME_ID, p2.address);
      expect(await token.balanceOf(await pool.getAddress())).to.equal(0n);
    });
  });

  describe("admin", () => {
    it("blocks create/join while paused", async () => {
      await pool.connect(owner).pause();
      await expect(
        pool.connect(p1).createGame(STAKE, GAME_ID)
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
      await pool.connect(owner).unpause();
      await expect(pool.connect(p1).createGame(STAKE, GAME_ID)).to.emit(
        pool,
        "GameCreated"
      );
    });

    it("rescues stray ETH via withdrawETH", async () => {
      await owner.sendTransaction({
        to: await pool.getAddress(),
        value: ethers.parseEther("1"),
      });
      const before = await ethers.provider.getBalance(company.address);
      await pool.connect(owner).withdrawETH(company.address);
      expect(
        (await ethers.provider.getBalance(company.address)) - before
      ).to.equal(ethers.parseEther("1"));
    });

    it("exposes the template constant and wiring", async () => {
      expect(await pool.ABANDONMENT_TIMEOUT()).to.equal(ABANDONMENT_TIMEOUT);
      expect(await pool.rewardToken()).to.equal(await token.getAddress());
      expect(await pool.DDawgsNFT()).to.equal(await nft.getAddress());
      expect(await pool.poolAddress()).to.equal(burnPool.address);
      expect(await pool.companyWallet()).to.equal(company.address);
    });
  });
});
