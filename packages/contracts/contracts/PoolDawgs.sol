// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
// Constructor-free, transient-storage guard (EIP-1153, Cancun+) — proxy-safe;
// OZ 5.6 no longer ships an upgradeable ReentrancyGuard variant.
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title PoolDawgs — wagered 8-ball pool staking/escrow
/// @notice Direct adaptation of the deployed ChessDawgs contract
///         (0x543bd22deda83bc17c5bb6bbaa98beba5bbb8dd0 on Ethereum): same
///         external interface — string gameIds, the exit-request/draw flow,
///         poolAddress as the burn destination — with playerWhite/playerBlack
///         renamed to playerOne/playerTwo (pool has no colours).
///
///         The trusted backend (contract owner) is the sole authority on
///         outcomes: it simulates every shot server-side and calls finishGame
///         with the winner — covering pot wins, resignations, and 4-minute
///         shot-clock forfeits. There is deliberately NO on-chain timer.
///         The draw/exit path is kept for cross-game template parity but is
///         dormant in pool (win/loss only in practice).
contract PoolDawgs is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    struct Game {
        address playerOne;
        address playerTwo;
        bool isCompleted;
        address winner;
        uint256 stake; // per-player stake
        bool rewardClaimed;
        bool exitRequested;
        address exitRequester;
        uint256 exitRequestTimestamp;
        bool exitAccepted;
        bool playerOneClaimed;
        bool playerTwoClaimed;
        bool drawCompleted;
    }

    /// @notice Grace window (template value: 1 hour) — after it, an ignored
    ///         exit request may be drawn by the owner, and unclaimed payouts
    ///         may be swept via ownerWithdrawUnpaid.
    uint256 public constant ABANDONMENT_TIMEOUT = 3600;

    uint256 private constant WINNER_PERCENT = 80;
    uint256 private constant COMPANY_PERCENT = 10;
    uint256 private constant BURN_PERCENT = 10;

    IERC20 public rewardToken;
    /// @notice Primary gate NFT — the PoolDawgs membership pass (PoolDawgsNFT).
    IERC721 public DDawgsNFT;
    /// @notice Grandfather exception — holders of the existing ChessDawgs NFT
    ///         (0xf82E0cF5605101efE12689461c2bC9392BfDedEF on mainnet) may play
    ///         without minting a PoolDawgs pass. Optional (may be the zero
    ///         address); set/updated via setChessDawgsNFT.
    IERC721 public chessDawgsNFT;
    /// @notice Burn destination — receives the 10% burn cut, as in ChessDawgs.
    address public poolAddress;
    address public companyWallet;

    mapping(string => Game) public games;
    mapping(string => mapping(address => bool)) public playerPaid;
    mapping(string => uint256) private completedAt;

    /// @notice Low-privilege relayer key allowed to settle games (finishGame,
    ///         exit/draw). It can record outcomes but CANNOT move funds, change
    ///         wallets/gate, pause, or upgrade — so the hot key the backend
    ///         holds has a small blast radius. Set/rotated by the owner.
    ///         Appended at the end of storage to keep the upgrade layout safe.
    address public operator;

    /// @notice Backend signer for win vouchers. The backend NEVER sends a
    ///         settlement tx; it signs an EIP-712 Result(gameId, winner) voucher
    ///         off-chain, and the winner redeems it via claimRewardSigned — the
    ///         contract just validates that the recovered signer == resultSigner.
    ///         So this address holds a signing-only key (a sealed env var or a
    ///         KMS key) that can't move funds or touch the contract directly.
    address public resultSigner;

    /// @notice Optional central DDawgsNFTRegistry. When set, the play gate
    ///         defers to registry.ownsAny so ANY registered DDawgs game NFT
    ///         unlocks play — no contract change to add a future game's NFT.
    address public registry;

    bytes32 private constant RESULT_TYPEHASH =
        keccak256("Result(string gameId,address winner)");

    event GameCreated(string gameId, address indexed playerOne, uint256 stake);
    event GameJoined(string gameId, address indexed playerTwo);
    event GameFinished(string gameId, address winner, uint256 reward);
    event GameCancelled(string gameId, address indexed playerOne, uint256 refund);
    event ExitRequested(string gameId, address indexed requester);
    event ExitRequestAccepted(string gameId, address indexed accepter);
    event ExitRequestRejected(string gameId, address indexed rejecter);
    event GameExited(string gameId, uint256 totalCompanyRevenue, uint256 totalBurnedAmount);
    event DrawRewardClaimed(string gameId, address indexed player, uint256 amount);
    event OwnerWithdrawal(string gameId, address indexed player, uint256 amount);
    event ChessDawgsNFTUpdated(address indexed nft);
    event DDawgsNFTUpdated(address indexed nft);
    event OperatorUpdated(address indexed operator);
    event ResultSignerUpdated(address indexed signer);
    event RegistryUpdated(address indexed registry);

    /// @notice Relayer authority: the owner OR the dedicated operator may settle
    ///         games. Admin powers (funds, wallets, gate, pause, upgrade) stay
    ///         owner-only.
    modifier onlyRelayer() {
        require(msg.sender == owner() || msg.sender == operator, "not authorized");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _rewardToken,
        address _dDawgsNFT,
        address _chessDawgsNFT,
        address _poolAddress,
        address _companyWallet
    ) external initializer {
        require(_rewardToken != address(0), "zero token");
        require(_dDawgsNFT != address(0), "zero nft");
        require(_poolAddress != address(0), "zero pool");
        require(_companyWallet != address(0), "zero company");

        __Ownable_init(msg.sender);
        __Pausable_init();
        __EIP712_init("PoolDawgs", "1");

        rewardToken = IERC20(_rewardToken);
        DDawgsNFT = IERC721(_dDawgsNFT);
        chessDawgsNFT = IERC721(_chessDawgsNFT); // may be zero
        poolAddress = _poolAddress;
        companyWallet = _companyWallet;
    }

    /// @notice The play gate. If a registry is set, ANY registered DDawgs NFT
    ///         unlocks play (registry.ownsAny) — with the local PoolDawgs pass /
    ///         grandfathered ChessDawgs NFT as a fallback. The registry call is a
    ///         guarded staticcall so a bad/unset registry can't brick the gate.
    function ownsNFT(address account) public view returns (bool) {
        if (registry != address(0)) {
            (bool ok, bytes memory data) = registry.staticcall(
                abi.encodeWithSignature("ownsAny(address)", account)
            );
            if (ok && data.length >= 32 && abi.decode(data, (bool))) return true;
        }
        if (DDawgsNFT.balanceOf(account) > 0) return true;
        if (address(chessDawgsNFT) != address(0) && chessDawgsNFT.balanceOf(account) > 0) {
            return true;
        }
        return false;
    }

    // ─────────────────────────── game lifecycle ───────────────────────────

    function createGame(uint256 stake, string memory _gameId)
        external
        whenNotPaused
        nonReentrant
        returns (string memory)
    {
        require(bytes(_gameId).length > 0, "empty gameId");
        require(games[_gameId].playerOne == address(0), "gameId taken");
        require(stake > 0, "zero stake");
        require(ownsNFT(msg.sender), "must own a Dawgs NFT");

        Game storage g = games[_gameId];
        g.playerOne = msg.sender;
        g.stake = stake;

        rewardToken.safeTransferFrom(msg.sender, address(this), stake);
        emit GameCreated(_gameId, msg.sender, stake);
        return _gameId;
    }

    function joinGame(string memory gameId) external whenNotPaused nonReentrant {
        Game storage g = games[gameId];
        require(g.playerOne != address(0), "no such game");
        require(g.playerTwo == address(0), "game full");
        require(!g.isCompleted, "game completed");
        require(msg.sender != g.playerOne, "cannot play yourself");
        require(ownsNFT(msg.sender), "must own a Dawgs NFT");

        g.playerTwo = msg.sender;

        rewardToken.safeTransferFrom(msg.sender, address(this), g.stake);
        emit GameJoined(gameId, msg.sender);
    }

    /// @notice Creator may withdraw an unmatched game and recover the stake.
    function cancelGame(string memory gameId) external nonReentrant {
        Game storage g = games[gameId];
        require(g.playerOne == msg.sender, "not your game");
        require(g.playerTwo == address(0), "opponent joined");
        require(!g.isCompleted, "game completed");

        uint256 refund = g.stake;
        delete games[gameId];

        rewardToken.safeTransfer(msg.sender, refund);
        emit GameCancelled(gameId, msg.sender, refund);
    }

    /// @notice Backend authority reports the winner. Covers normal wins,
    ///         resignations, and shot-clock forfeits — the off-chain server
    ///         decides which; the chain only records the result.
    function finishGame(string memory gameId, address winner) external onlyRelayer {
        Game storage g = games[gameId];
        require(g.playerOne != address(0) && g.playerTwo != address(0), "game not active");
        require(!g.isCompleted, "game completed");
        require(winner == g.playerOne || winner == g.playerTwo, "winner not a player");

        g.isCompleted = true;
        g.winner = winner;
        completedAt[gameId] = block.timestamp;

        emit GameFinished(gameId, winner, _winnerShare(g.stake));
    }

    /// @notice Winner pulls 80% of the pot; 10% goes to the company wallet,
    ///         10% to the pool address (burn).
    function claimReward(string memory gameId) external nonReentrant {
        Game storage g = games[gameId];
        require(g.isCompleted && !g.drawCompleted, "no win to claim");
        require(msg.sender == g.winner, "not the winner");
        require(!g.rewardClaimed, "already claimed");

        g.rewardClaimed = true;
        playerPaid[gameId][msg.sender] = true;

        uint256 pot = g.stake * 2;
        rewardToken.safeTransfer(g.winner, _winnerShare(g.stake));
        rewardToken.safeTransfer(companyWallet, (pot * COMPANY_PERCENT) / 100);
        rewardToken.safeTransfer(poolAddress, (pot * BURN_PERCENT) / 100);
    }

    /// @notice Winner-driven claim with a backend voucher. The backend signs an
    ///         EIP-712 Result(gameId, winner) off-chain (no transaction); the
    ///         winner submits it here and the contract validates that the
    ///         recovered signer == resultSigner, then settles + pays out. This
    ///         keeps the backend's key signing-only and off-chain.
    function claimRewardSigned(string memory gameId, bytes calldata signature)
        external
        nonReentrant
    {
        Game storage g = games[gameId];
        require(g.playerOne != address(0) && g.playerTwo != address(0), "game not active");
        require(!g.isCompleted && !g.drawCompleted, "already settled");
        require(!g.rewardClaimed, "already claimed");
        require(msg.sender == g.playerOne || msg.sender == g.playerTwo, "not a player");
        require(resultSigner != address(0), "signer unset");

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(RESULT_TYPEHASH, keccak256(bytes(gameId)), msg.sender))
        );
        require(ECDSA.recover(digest, signature) == resultSigner, "bad voucher");

        g.isCompleted = true;
        g.winner = msg.sender;
        g.rewardClaimed = true;
        completedAt[gameId] = block.timestamp;
        playerPaid[gameId][msg.sender] = true;

        uint256 pot = g.stake * 2;
        uint256 share = _winnerShare(g.stake);
        rewardToken.safeTransfer(msg.sender, share);
        rewardToken.safeTransfer(companyWallet, (pot * COMPANY_PERCENT) / 100);
        rewardToken.safeTransfer(poolAddress, (pot * BURN_PERCENT) / 100);

        emit GameFinished(gameId, msg.sender, share);
    }

    // ────────────── exit/draw flow (ChessDawgs template parity) ──────────────
    // Pool has no draws in practice (resign = loss, timeout = forfeit), but the
    // flow is kept so every Dawgs game shares an identical contract shape.
    // All steps are owner-relayed: clients never talk to the chain mid-game.

    function ownerRequestExitGame(string memory gameId, address player) external onlyRelayer {
        Game storage g = games[gameId];
        require(g.playerOne != address(0) && g.playerTwo != address(0), "game not active");
        require(!g.isCompleted, "game completed");
        require(player == g.playerOne || player == g.playerTwo, "not a player");
        require(!g.exitRequested, "already requested");

        g.exitRequested = true;
        g.exitRequester = player;
        g.exitRequestTimestamp = block.timestamp;
        emit ExitRequested(gameId, player);
    }

    function ownerAcceptExitRequest(string memory gameId, address player) external onlyRelayer {
        Game storage g = games[gameId];
        require(g.exitRequested && !g.exitAccepted, "no pending request");
        require(
            (player == g.playerOne || player == g.playerTwo) && player != g.exitRequester,
            "accepter must be the opponent"
        );

        g.exitAccepted = true;
        emit ExitRequestAccepted(gameId, player);
    }

    function ownerRejectExitRequest(string memory gameId, address player) external onlyRelayer {
        Game storage g = games[gameId];
        require(g.exitRequested && !g.exitAccepted, "no pending request");

        g.exitRequested = false;
        g.exitRequester = address(0);
        g.exitRequestTimestamp = 0;
        emit ExitRequestRejected(gameId, player);
    }

    /// @notice Finalises a draw once the opponent accepted — or unilaterally
    ///         after ABANDONMENT_TIMEOUT if they ignored the request. Takes
    ///         the 10% company and 10% burn cuts immediately; players then
    ///         pull their 40% halves via claimDrawReward.
    function drawGame(string memory gameId, address requester) external onlyRelayer nonReentrant {
        Game storage g = games[gameId];
        require(g.playerOne != address(0) && g.playerTwo != address(0), "game not active");
        require(!g.isCompleted, "game completed");
        require(g.exitRequested && g.exitRequester == requester, "no matching request");
        require(
            g.exitAccepted ||
                block.timestamp >= g.exitRequestTimestamp + ABANDONMENT_TIMEOUT,
            "not accepted nor abandoned"
        );

        g.isCompleted = true;
        g.drawCompleted = true;
        completedAt[gameId] = block.timestamp;

        uint256 pot = g.stake * 2;
        uint256 companyShare = (pot * COMPANY_PERCENT) / 100;
        uint256 burnShare = (pot * BURN_PERCENT) / 100;
        rewardToken.safeTransfer(companyWallet, companyShare);
        rewardToken.safeTransfer(poolAddress, burnShare);

        emit GameExited(gameId, companyShare, burnShare);
    }

    /// @notice On a draw each player pulls 40% of the pot.
    function claimDrawReward(string memory gameId) external nonReentrant {
        Game storage g = games[gameId];
        require(g.drawCompleted, "not a draw");
        require(msg.sender == g.playerOne || msg.sender == g.playerTwo, "not a player");

        if (msg.sender == g.playerOne) {
            require(!g.playerOneClaimed, "already claimed");
            g.playerOneClaimed = true;
        } else {
            require(!g.playerTwoClaimed, "already claimed");
            g.playerTwoClaimed = true;
        }
        playerPaid[gameId][msg.sender] = true;

        uint256 amount = _drawShare(g.stake);
        rewardToken.safeTransfer(msg.sender, amount);
        emit DrawRewardClaimed(gameId, msg.sender, amount);
    }

    // ─────────────────────────── safety nets / admin ───────────────────────────

    /// @notice If a payout is never claimed (e.g. UI bug), the owner can sweep
    ///         that player's share to the company wallet after the timeout.
    function ownerWithdrawUnpaid(string memory gameId, address player)
        external
        onlyOwner
        nonReentrant
    {
        Game storage g = games[gameId];
        require(g.isCompleted, "game not completed");
        require(
            block.timestamp > completedAt[gameId] + ABANDONMENT_TIMEOUT,
            "claim window open"
        );

        uint256 amount;
        if (g.drawCompleted) {
            require(player == g.playerOne || player == g.playerTwo, "not a player");
            if (player == g.playerOne) {
                require(!g.playerOneClaimed, "already paid");
                g.playerOneClaimed = true;
            } else {
                require(!g.playerTwoClaimed, "already paid");
                g.playerTwoClaimed = true;
            }
            amount = _drawShare(g.stake);
        } else {
            require(player == g.winner, "not the winner");
            require(!g.rewardClaimed, "already paid");
            g.rewardClaimed = true;
            uint256 pot = g.stake * 2;
            // Win path: company + burn cuts were never taken either.
            rewardToken.safeTransfer(poolAddress, (pot * BURN_PERCENT) / 100);
            amount = _winnerShare(g.stake) + (pot * COMPANY_PERCENT) / 100;
        }

        rewardToken.safeTransfer(companyWallet, amount);
        emit OwnerWithdrawal(gameId, player, amount);
    }

    function setCompanyWallet(address _companyWallet) external onlyOwner {
        require(_companyWallet != address(0), "zero company");
        companyWallet = _companyWallet;
    }

    /// @notice Update (or clear) the grandfathered ChessDawgs NFT.
    function setChessDawgsNFT(address _chessDawgsNFT) external onlyOwner {
        chessDawgsNFT = IERC721(_chessDawgsNFT);
        emit ChessDawgsNFTUpdated(_chessDawgsNFT);
    }

    /// @notice Re-point the primary membership-pass NFT (the play gate). Lets a
    ///         redeployed PoolDawgsNFT (e.g. one with real metadata) be wired in
    ///         without redeploying the escrow.
    function setDDawgsNFT(address _dDawgsNFT) external onlyOwner {
        require(_dDawgsNFT != address(0), "zero nft");
        DDawgsNFT = IERC721(_dDawgsNFT);
        emit DDawgsNFTUpdated(_dDawgsNFT);
    }

    /// @notice Set (or clear, with the zero address) the relayer/operator key
    ///         allowed to settle games. Keep this on a dedicated low-value
    ///         signer (a sealed env var or a KMS key) — never the owner key.
    function setOperator(address _operator) external onlyOwner {
        operator = _operator;
        emit OperatorUpdated(_operator);
    }

    /// @notice Set (or clear) the backend voucher signer. Keep its key off-chain
    ///         (sealed env / KMS) — it signs win vouchers but never transacts.
    function setResultSigner(address _signer) external onlyOwner {
        resultSigner = _signer;
        emit ResultSignerUpdated(_signer);
    }

    /// @notice Set (or clear) the central DDawgsNFTRegistry used by the gate.
    ///         The address is validated — it must answer `ownsAny(address)` with
    ///         a bool — so a wrong/incompatible contract can't be wired in.
    function setRegistry(address _registry) external onlyOwner {
        if (_registry != address(0)) {
            (bool ok, bytes memory data) = _registry.staticcall(
                abi.encodeWithSignature("ownsAny(address)", address(this))
            );
            require(ok && data.length >= 32, "bad registry");
        }
        registry = _registry;
        emit RegistryUpdated(_registry);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Rescue stray ETH sent to the contract (template parity).
    function withdrawETH(address payable to) external onlyOwner {
        require(to != address(0), "zero address");
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "ETH transfer failed");
    }

    receive() external payable {}

    fallback() external payable {}

    // ─────────────────────────── internals ───────────────────────────

    function _winnerShare(uint256 stake) private pure returns (uint256) {
        return (stake * 2 * WINNER_PERCENT) / 100;
    }

    function _drawShare(uint256 stake) private pure returns (uint256) {
        return (stake * 2 * WINNER_PERCENT) / 100 / 2;
    }

    // Reduced from 40 → 39 when chessDawgsNFT was added (one new slot).
    uint256[38] private __gap;
}
