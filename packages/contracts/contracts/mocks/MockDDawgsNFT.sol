// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockDDawgsNFT is ERC721 {
    uint256 private _nextId = 1;

    constructor() ERC721("Deputy Dawgs NFT", "DDAWG") {}

    function mint(address to) external returns (uint256 tokenId) {
        tokenId = _nextId++;
        _mint(to, tokenId);
    }
}
