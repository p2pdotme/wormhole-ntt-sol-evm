// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GovernanceNttToken} from "../src/GovernanceNttToken.sol";

contract GovernanceNttTokenTest is Test {
    GovernanceNttToken token;
    address owner = address(0xA11CE);
    address manager = address(0xB0B);
    address user = address(0xCAFE);

    function setUp() public {
        token = new GovernanceNttToken("Gov", "GOV", 9, owner);
    }

    function test_decimalsMatchSpl() public view {
        assertEq(token.decimals(), 9);
    }

    function test_onlyOwnerSetsMinter() public {
        vm.expectRevert();
        token.setMinter(manager);

        vm.prank(owner);
        token.setMinter(manager);
        assertEq(token.minter(), manager);
    }

    function test_setMinterRejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(GovernanceNttToken.InvalidMinterZeroAddress.selector);
        token.setMinter(address(0));
    }

    function test_onlyMinterMints() public {
        vm.prank(owner);
        token.setMinter(manager);

        vm.expectRevert(abi.encodeWithSelector(GovernanceNttToken.CallerNotMinter.selector, user));
        vm.prank(user);
        token.mint(user, 1e9);

        vm.prank(manager);
        token.mint(user, 1e9);
        assertEq(token.balanceOf(user), 1e9);
    }

    function test_burnFlow() public {
        vm.prank(owner);
        token.setMinter(manager);

        vm.prank(manager);
        token.mint(manager, 5e9);

        vm.prank(manager);
        token.burn(2e9);
        assertEq(token.balanceOf(manager), 3e9);
    }

    function test_clockModeIsTimestamp() public view {
        assertEq(token.clock(), uint48(block.timestamp));
        assertEq(token.CLOCK_MODE(), "mode=timestamp");
    }

    function test_votesAccountingPersists() public {
        vm.prank(owner);
        token.setMinter(manager);

        vm.prank(manager);
        token.mint(user, 100);

        vm.prank(user);
        token.delegate(user);

        vm.warp(block.timestamp + 1);
        assertEq(token.getVotes(user), 100);
    }
}
