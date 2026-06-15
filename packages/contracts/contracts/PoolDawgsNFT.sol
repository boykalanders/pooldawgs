// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title PoolDawgsNFT — the membership pass that gates PoolDawgs play.
/// @notice Free public mint, one per wallet. Holding this (or a ChessDawgs
///         NFT — the grandfather exception, checked by PoolDawgs.sol) lets a
///         wallet create and join wagered games.
/// @dev    Per-token metadata uses OpenZeppelin's audited `Strings.toString`
///         (`baseURI + tokenId + ".json"`) rather than a hand-rolled integer
///         formatter, and a plain `uint256` counter — OZ 5.x removed the old
///         `Counters` library, so the ChessDawgs-era pattern won't compile here.
contract PoolDawgsNFT is ERC721URIStorage, Ownable {
    using Strings for uint256;

    uint256 private _nextId = 1;
    string private _baseTokenURI;

    event Minted(address indexed to, uint256 indexed tokenId);

    constructor(string memory baseURI) ERC721("Pool Dawgs", "PDAWG") Ownable(msg.sender) {
        _baseTokenURI = baseURI;
    }

    /// @notice Mint your membership pass. One per wallet.
    function mint() external returns (uint256 tokenId) {
        require(balanceOf(msg.sender) == 0, "already minted");
        tokenId = _mintPass(msg.sender);
    }

    /// @notice Owner-only seed mint (deploy scripts / airdrops).
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

    function setBaseURI(string calldata baseURI) external onlyOwner {
        _baseTokenURI = baseURI;
    }

    function _mintPass(address to) internal returns (uint256 tokenId) {
        tokenId = _nextId++;
        _safeMint(to, tokenId);
        if (bytes(_baseTokenURI).length > 0) {
            // baseURI + "<tokenId>.json" — OZ Strings.toString, not a manual loop.
            _setTokenURI(tokenId, string.concat(_baseTokenURI, tokenId.toString(), ".json"));
        }
        emit Minted(to, tokenId);
    }
}
