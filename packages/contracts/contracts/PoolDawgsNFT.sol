// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title PoolDawgsNFT — the membership pass that gates PoolDawgs play.
/// @notice Free public mint, one per wallet. Holding this (or a ChessDawgs
///         NFT — the grandfather exception, checked by PoolDawgs.sol) lets a
///         wallet create and join wagered games.
/// @dev    Metadata mirrors the ChessDawgs scheme: tokenURI(id) resolves to
///         `<baseURI><id>.json` and is computed AT READ TIME (not frozen at
///         mint). That means `setBaseURI` is retroactive — set it once and
///         every pass, already-minted included, resolves its metadata. Host
///         each `<id>.json` returning `{ "name", "image", ... }`.
contract PoolDawgsNFT is ERC721, Ownable {
    using Strings for uint256;

    uint256 private _nextId = 1;
    string private _baseTokenURI;

    event Minted(address indexed to, uint256 indexed tokenId);
    event BaseURIUpdated(string baseURI);

    constructor(string memory baseURI) ERC721("Pool Dawgs", "PDAWG") Ownable(msg.sender) {
        _baseTokenURI = baseURI;
    }

    /// @notice Mint your membership pass. One per wallet.
    function mint() external returns (uint256 tokenId) {
        require(balanceOf(msg.sender) == 0, "already minted");
        tokenId = _mintPass(msg.sender);
    }

    /// @notice Owner-only seed mint (deploy scripts / airdrops). No per-wallet cap.
    function ownerMint(address to) external onlyOwner returns (uint256 tokenId) {
        tokenId = _mintPass(to);
    }

    /// @notice True once `account` holds a pass (mirrors the gate check).
    function owns(address account) external view returns (bool) {
        return balanceOf(account) > 0;
    }

    function totalMinted() external view returns (uint256) {
        return _nextId - 1;
    }

    /// @notice Set (or clear) the metadata base URI. RETROACTIVE: applies to
    ///         every token at once. Include the trailing slash, e.g.
    ///         "https://backend.example.io/v1/nft/pooldawgs/".
    function setBaseURI(string calldata baseURI) external onlyOwner {
        _baseTokenURI = baseURI;
        emit BaseURIUpdated(baseURI);
    }

    /// @return `<baseURI><tokenId>.json`, or "" when no base URI is set.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (bytes(_baseTokenURI).length == 0) return "";
        return string.concat(_baseTokenURI, tokenId.toString(), ".json");
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function _mintPass(address to) internal returns (uint256 tokenId) {
        tokenId = _nextId++;
        _safeMint(to, tokenId);
        emit Minted(to, tokenId);
    }
}
