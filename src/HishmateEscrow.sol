// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title HishmateEscrow
 * @notice Custody contract for the Hishmate task platform on Arbitrum.
 *
 * The contract is the on-chain half of a custodial design: the platform keeps
 * an internal ledger (D1) that mirrors everything that happens here, and the
 * events below are what the backend verifies before it credits or moves a
 * single internal unit. Nothing in here trusts the caller except the
 * arbitrator role, which only the platform holds.
 *
 * Money model (mirrors the internal ledger 1:1, USDC 6-decimals):
 * - `balanceOf`   spendable credits (top up with `deposit`, cash out with
 *                 `withdraw` — the user pays their own gas — or let the
 *                 platform push it with `withdrawFor`).
 * - `bondOf`      long-term bond custody. Deposited once, never re-frozen
 *                 per task; `heldBondOf` is the part currently occupied by
 *                 live tasks. `freeBondOf` is the eligibility number:
 *                 >= BOND_PUBLISHER means "can publish", >= BOND_WORKER
 *                 means "can take work".
 * - `tasks`       per-task escrow (the bounty) only.
 *
 * Bond occupancy is deliberately role-agnostic: `holdBond` does not care
 * whether the holder is the publisher or the worker of the task named in the
 * event. The platform knows the roles; the contract only enforces the
 * conservation invariants (held <= bond, held <= free at hold time) and
 * emits task-tagged events the backend matches against its own ledger.
 *
 * Gas policy: users pay for the calls they make themselves (deposit,
 * withdraw, fundTask); the platform's arbitrator pays for settlement, and the
 * publisher pre-pays that cost as a gas reserve off-chain.
 */
contract HishmateEscrow is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice USDC (6 decimals) this instance custodies.
    IERC20 public immutable usdc;

    /// @notice Platform address allowed to settle, refund, arbitrate and push
    /// withdrawals. Settled by the owner.
    address public arbitrator;

    /// @notice Spendable credits per user.
    mapping(address => uint256) public balanceOf;
    /// @notice Bond in long-term custody per user.
    mapping(address => uint256) public bondOf;
    /// @notice Part of the custody currently occupied by live tasks.
    mapping(address => uint256) public heldBondOf;

    struct Task {
        address funder;
        uint256 escrow;
        bool settled;
    }
    /// @notice Per-task custody, keyed by the platform's task id.
    mapping(bytes32 => Task) public tasks;

    // ── events (the backend verifies these) ───────────────────────────────
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event BondDeposited(address indexed user, uint256 amount);
    event BondWithdrawn(address indexed user, uint256 amount);
    event BondHeld(address indexed user, bytes32 indexed task, uint256 amount);
    event BondReleased(address indexed user, bytes32 indexed task, uint256 amount);
    event BondSlashed(
        address indexed user,
        bytes32 indexed task,
        uint256 amount,
        address indexed to
    );
    event TaskFunded(address indexed publisher, bytes32 indexed task, uint256 amount);
    event TaskSettled(bytes32 indexed task, address indexed worker, uint256 amount);
    event TaskRefunded(bytes32 indexed task, address indexed publisher, uint256 amount);
    event TaskArbitrated(
        bytes32 indexed task,
        address indexed worker,
        uint256 award,
        uint256 workerBond,
        address indexed bondTo
    );
    event ArbitratorChanged(address indexed previous, address indexed next);

    // ── errors ────────────────────────────────────────────────────────────
    error NotArbitrator();
    error ZeroAmount();
    error InsufficientBalance();
    error InsufficientFreeBond();
    error InsufficientHeldBond();
    error BondOccupied();
    error NotTaskFunder();
    error TaskAlreadySettled();
    error TaskNotFunded();
    error AwardTooLarge();
    error BondTooLarge();

    modifier onlyArbitrator() {
        if (msg.sender != arbitrator) revert NotArbitrator();
        _;
    }

    constructor(IERC20 usdc_, address arbitrator_, address owner_)
        Ownable(owner_)
    {
        usdc = usdc_;
        arbitrator = arbitrator_;
        emit ArbitratorChanged(address(0), arbitrator_);
    }

    // ── admin ─────────────────────────────────────────────────────────────
    function setArbitrator(address next) external onlyOwner {
        emit ArbitratorChanged(arbitrator, next);
        arbitrator = next;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ── user: credits ─────────────────────────────────────────────────────
    /// @notice Pull USDC in and credit `balanceOf`. The caller must have
    /// approved this contract first; the caller pays the gas.
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Cash credits out as USDC to the caller (caller pays gas).
    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Platform-pushed withdrawal: same effect as `withdraw`, but the
    /// arbitrator pays the gas so a user without ETH can still cash out.
    function withdrawFor(address user, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        onlyArbitrator
    {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf[user] < amount) revert InsufficientBalance();
        balanceOf[user] -= amount;
        usdc.safeTransfer(user, amount);
        emit Withdrawn(user, amount);
    }

    // ── user: bond custody ────────────────────────────────────────────────
    /// @notice Move spendable credits into long-term bond custody. This is
    /// the one-time action that makes a user eligible to publish or take
    /// work; it is not tied to any task.
    function depositBond(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        bondOf[msg.sender] += amount;
        emit BondDeposited(msg.sender, amount);
    }

    /// @notice Take custody back into spendable credits. Requires zero
    /// occupied bond: a user with a live task cannot pull the bond out from
    /// under it. Cashing the credits out is a separate `withdraw`.
    function withdrawBond(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (heldBondOf[msg.sender] != 0) revert BondOccupied();
        if (bondOf[msg.sender] < amount) revert InsufficientBalance();
        bondOf[msg.sender] -= amount;
        balanceOf[msg.sender] += amount;
        emit BondWithdrawn(msg.sender, amount);
    }

    /// @notice Free (unoccupied) custody — the eligibility number.
    function freeBondOf(address user) external view returns (uint256) {
        return bondOf[user] - heldBondOf[user];
    }

    // ── publisher: task escrow ────────────────────────────────────────────
    /// @notice Lock a bounty into a task's escrow out of the caller's
    /// spendable credits. The caller pays the gas — this is the "click to
    /// disburse" step that puts real USDC behind a task.
    function fundTask(bytes32 taskId, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        Task storage t = tasks[taskId];
        if (t.funder == address(0)) t.funder = msg.sender;
        else if (t.funder != msg.sender) revert NotTaskFunder();
        if (t.settled) revert TaskAlreadySettled();
        balanceOf[msg.sender] -= amount;
        t.escrow += amount;
        emit TaskFunded(msg.sender, taskId, amount);
    }

    // ── arbitrator: bond occupancy ────────────────────────────────────────
    /// @notice Occupy part of a user's custody for a live task. Role-
    /// agnostic: the platform decides whose bond (publisher's or worker's)
    /// this is. Eligibility stays: the money never leaves `bondOf`, it is
    /// only marked busy.
    function holdBond(address user, bytes32 taskId, uint256 amount)
        external
        onlyArbitrator
    {
        if (amount == 0) revert ZeroAmount();
        if (bondOf[user] - heldBondOf[user] < amount)
            revert InsufficientFreeBond();
        heldBondOf[user] += amount;
        emit BondHeld(user, taskId, amount);
    }

    /// @notice Free an occupancy (task finished cleanly).
    function releaseBond(address user, bytes32 taskId, uint256 amount)
        external
        onlyArbitrator
    {
        if (amount == 0) revert ZeroAmount();
        if (heldBondOf[user] < amount) revert InsufficientHeldBond();
        heldBondOf[user] -= amount;
        emit BondReleased(user, taskId, amount);
    }

    /// @notice Destroy part of a user's custody and pay it to `to` as
    /// spendable credits (the counterparty's compensation).
    function slashBond(
        address user,
        bytes32 taskId,
        uint256 amount,
        address to
    ) external onlyArbitrator {
        if (amount == 0) revert ZeroAmount();
        if (heldBondOf[user] < amount) revert InsufficientHeldBond();
        heldBondOf[user] -= amount;
        bondOf[user] -= amount;
        balanceOf[to] += amount;
        emit BondSlashed(user, taskId, amount, to);
    }

    // ── arbitrator: task money ────────────────────────────────────────────
    /// @notice Approved delivery: the escrowed bounty becomes the worker's
    /// spendable credits. Bond occupancies are released separately.
    function settleTask(bytes32 taskId, address worker)
        external
        onlyArbitrator
    {
        Task storage t = tasks[taskId];
        if (t.settled) revert TaskAlreadySettled();
        uint256 amount = t.escrow;
        if (amount == 0) revert TaskNotFunded();
        t.settled = true;
        t.escrow = 0;
        balanceOf[worker] += amount;
        emit TaskSettled(taskId, worker, amount);
    }

    /// @notice Rejected/cancelled/expired: the escrow goes back to the funder.
    function refundTask(bytes32 taskId) external onlyArbitrator {
        Task storage t = tasks[taskId];
        if (t.settled) revert TaskAlreadySettled();
        uint256 amount = t.escrow;
        if (amount == 0) revert TaskNotFunded();
        t.settled = true;
        t.escrow = 0;
        balanceOf[t.funder] += amount;
        emit TaskRefunded(taskId, t.funder, amount);
    }

    /// @notice Arbitration: split the escrow (award to the worker, the rest
    /// back to the funder) and either free or slash the worker bond.
    ///
    /// `workerBond` is the amount the platform wants to slash out of the
    /// worker's custody; it is capped by `heldBondOf[worker]` so a wrong
    /// figure can never underflow. When `slashWorkerBond` is false the
    /// occupancy simply stays in place and the platform releases it with a
    /// separate `releaseBond` once the books agree.
    function arbitrateTask(
        bytes32 taskId,
        address worker,
        uint256 award,
        uint256 workerBond,
        bool slashWorkerBond
    ) external onlyArbitrator {
        Task storage t = tasks[taskId];
        if (t.settled) revert TaskAlreadySettled();
        uint256 amount = t.escrow;
        if (amount == 0) revert TaskNotFunded();
        if (award > amount) revert AwardTooLarge();
        if (workerBond > heldBondOf[worker]) revert BondTooLarge();
        t.settled = true;
        t.escrow = 0;
        if (award > 0) balanceOf[worker] += award;
        if (amount - award > 0) balanceOf[t.funder] += amount - award;
        if (slashWorkerBond && workerBond > 0) {
            heldBondOf[worker] -= workerBond;
            bondOf[worker] -= workerBond;
            balanceOf[t.funder] += workerBond;
            emit BondSlashed(worker, taskId, workerBond, t.funder);
        }
        emit TaskArbitrated(taskId, worker, award, workerBond, t.funder);
    }
}
