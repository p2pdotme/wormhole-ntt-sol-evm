// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit, Nonces} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Governance ERC20 (Votes + Permit) that also satisfies Wormhole NTT's
///         INttToken interface so an NttManager configured in burning mode can
///         mint and burn this token to/from the canonical supply on Solana.
///
///         Trust model:
///         - `owner` (deployer / multisig) controls who the minter is.
///         - `minter` (set to the NttManager after deploy) is the only address
///           allowed to call `mint`. Burns happen via the standard
///           ERC20Burnable.burn flow on tokens already pulled into the manager.
///
///         Decimals: matches the SPL mint on Solana to avoid trim-on-transfer
///         precision loss inside NTT. Override `decimals()` if your SPL uses
///         something other than 9 or 18.
contract GovernanceNttToken is
    ERC20,
    ERC20Burnable,
    ERC20Permit,
    ERC20Votes,
    Ownable2Step
{
    /// @notice The address authorized to mint new supply. Set to the NttManager
    ///         on Base after both sides are deployed.
    address public minter;

    uint8 private immutable _decimals;

    error CallerNotMinter(address caller);
    error InvalidMinterZeroAddress();

    event NewMinter(address indexed previousMinter, address indexed newMinter);

    /// @param name_      ERC20 name
    /// @param symbol_    ERC20 symbol
    /// @param decimals_  Must match the SPL mint decimals on Solana.
    /// @param owner_     Initial owner (multisig recommended).
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address owner_
    )
        ERC20(name_, symbol_)
        ERC20Permit(name_)
        Ownable(owner_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /* -------------------------------------------------------------------- */
    /*                Base L2 timestamp clock (EIP-6372)                    */
    /* -------------------------------------------------------------------- */
    /// @dev Base L2 block numbers are not reliable for vote checkpoints.
    ///      Use timestamp mode so ERC20Votes/Governor work correctly.

    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    /* -------------------------------------------------------------------- */
    /*                              INttToken                               */
    /* -------------------------------------------------------------------- */

    /// @notice Set the NttManager (or other authorized minter). Two-step
    ///         transfer of ownership protects against fat-fingered handover.
    function setMinter(address newMinter) external onlyOwner {
        if (newMinter == address(0)) revert InvalidMinterZeroAddress();
        address previous = minter;
        minter = newMinter;
        emit NewMinter(previous, newMinter);
    }

    /// @notice Mint new supply to `account`. Only callable by the configured
    ///         minter (NttManager in burning mode).
    function mint(address account, uint256 amount) external {
        if (msg.sender != minter) revert CallerNotMinter(msg.sender);
        _mint(account, amount);
    }

    /* -------------------------------------------------------------------- */
    /*                       OZ multi-inheritance hooks                     */
    /* -------------------------------------------------------------------- */

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, value);
    }

    function nonces(address ownerAddr)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(ownerAddr);
    }
}
