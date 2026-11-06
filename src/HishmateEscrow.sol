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
 * - `tasks`       per-task escrow (the bounty) only, plus the publisher the
 *                 platform registered for that task id with `openTask`.
 *
 * Task ids come from the platform, so a task id alone says nothing about who
 * is allowed to put money behind it: `fundTask` requires the caller to be the
 * publisher registered by `openTask`, never "whoever pays first". Without
 * that binding anyone could burn one unit of dust on a real task id and lock
 * the real publisher out with `NotTaskFunder` forever.
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

    /// @notice Two-step handover: an owner proposal is inert until the delay
    /// elapses and `acceptArbitrator` is called, giving monitors and the
    /// (multisig) owner time to veto a hostile change.
    address public pendingArbitrator;
    uint256 public arbitratorChangeAt;
    uint256 public constant ARBITRATOR_DELAY = 2 days;

    /// @notice Spendable credits per user.
    mapping(address => uint256) public balanceOf;
    /// @notice Bond in long-term custody per user.
    mapping(address => uint256) public bondOf;
    /// @notice Part of the custody currently occupied by live tasks.
    mapping(address => uint256) public heldBondOf;

    struct Task {
        address funder;
        address worker;
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
    event TaskOpened(bytes32 indexed task, address indexed publisher);
    event WorkerAssigned(bytes32 indexed task, address indexed worker);
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
    /// @notice Emitted when the requested slash exceeded what the worker
    /// actually holds, so the caller knows its figure was stale. The amount
    /// that was applied is the one carried by `BondSlashed` / `TaskArbitrated`.
    event BondSlashCapped(
        bytes32 indexed task,
        address indexed user,
        uint256 requested,
        uint256 applied
    );
    event ArbitratorChanged(address indexed previous, address indexed next);
    /// @notice A new arbitrator was proposed; it becomes effective only after
    /// `ARBITRATOR_DELAY` has elapsed (see `acceptArbitrator`). A pending
    /// change is always visible on chain, so monitoring can flag a hostile
    /// takeover before it lands.
    event ArbitratorProposed(address indexed next, uint256 effectiveAt);

    // ── errors ────────────────────────────────────────────────────────────
    error NotArbitrator();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance();
    error InsufficientFreeBond();
    error InsufficientHeldBond();
    error BondOccupied();
    error TaskNotOpen();
    error TaskAlreadyOpen();
    error TaskNoWorker();
    error WorkerAlreadySet();
    error ArbitratorChangeTooEarly();
    error NotTaskFunder();
    error TaskAlreadySettled();
    error TaskNotFunded();
    error AwardTooLarge();

    modifier onlyArbitrator() {
        if (msg.sender != arbitrator) revert NotArbitrator();
        _;
    }

    constructor(IERC20 usdc_, address arbitrator_, address owner_)
        Ownable(owner_)
    {
        if (arbitrator_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        arbitrator = arbitrator_;
        emit ArbitratorChanged(address(0), arbitrator_);
    }

    // ── admin ─────────────────────────────────────────────────────────────
    /// @notice Propose a new arbitrator. The change is *not* live until
    /// `ARBITRATOR_DELAY` has passed and `acceptArbitrator` is called, so a
    /// leaked owner key cannot hand settlement rights to an attacker in the
    /// same transaction. Refuses the zero address: with no proxy there is no
    /// way to walk that back once committed.
    function proposeArbitrator(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        pendingArbitrator = next;
        arbitratorChangeAt = block.timestamp + ARBITRATOR_DELAY;
        emit ArbitratorProposed(next, arbitratorChangeAt);
    }

    /// @notice Make a previously proposed arbitrator live. Reverts before the
    /// delay elapses, so monitoring that sees `ArbitratorProposed` has the
    /// whole window to call `cancelArbitratorChange`.
    function acceptArbitrator() external onlyOwner {
        address next = pendingArbitrator;
        if (next == address(0)) revert ZeroAddress();
        if (block.timestamp < arbitratorChangeAt)
            revert ArbitratorChangeTooEarly();
        pendingArbitrator = address(0);
        arbitratorChangeAt = 0;
        emit ArbitratorChanged(arbitrator, next);
        arbitrator = next;
    }

    /// @notice Veto a pending handover. The delay is the only window a leaked
    /// owner has to act in; the (multisig) owner should cancel on any
    /// unexpected `ArbitratorProposed`.
    function cancelArbitratorChange() external onlyOwner {
        pendingArbitrator = address(0);
        arbitratorChangeAt = 0;
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
        if (user == address(0)) revert ZeroAddress();
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

    // ── arbitrator: task registration ─────────────────────────────────────
    /// @notice Bind a task id to the wallet that is allowed to fund it. The
    /// platform calls this once when the task opens, before any money moves;
    /// it pays the gas, exactly like the other arbitrator calls.
    ///
    /// This is what makes `fundTask` safe to expose: a task id guessed or
    /// scraped from the board is worth nothing on its own, because funding it
    /// from any other wallet reverts with `NotTaskFunder`.
    function openTask(bytes32 taskId, address publisher) external onlyArbitrator {
        if (publisher == address(0)) revert ZeroAddress();
        Task storage t = tasks[taskId];
        if (t.settled) revert TaskAlreadySettled();
        // Re-pointing a task that already carries money would move the
        // refund destination out from under the funder — refuse instead of
        // silently trusting the caller to get it right.
        if (t.funder != address(0) && t.funder != publisher) revert TaskAlreadyOpen();
        t.funder = publisher;
        emit TaskOpened(taskId, publisher);
    }

    /// @notice Bind the worker that will receive a `settleTask` award or an
    /// `arbitrateTask` split for this task. Written exactly once — while
    /// `worker == address(0)` — and never changed afterwards. This is the
    /// single most important guard in the contract: it means a leaked
    /// arbitrator key can only ever pay the task's *real* counterparty, never
    /// an address of its own choosing. Requires the task to be open first
    /// (`openTask`), and refuses once settled.
    function assignWorker(bytes32 taskId, address worker) external onlyArbitrator {
        if (worker == address(0)) revert ZeroAddress();
        Task storage t = tasks[taskId];
        if (t.funder == address(0)) revert TaskNotOpen();
        if (t.settled) revert TaskAlreadySettled();
        if (t.worker != address(0)) revert WorkerAlreadySet();
        t.worker = worker;
        emit WorkerAssigned(taskId, worker);
    }

    // ── publisher: task escrow ────────────────────────────────────────────
    /// @notice Lock a bounty into a task's escrow out of the caller's
    /// spendable credits. The caller pays the gas — this is the "click to
    /// disburse" step that puts real USDC behind a task. Only the publisher
    /// registered by `openTask` may do it.
    function fundTask(bytes32 taskId, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();
        Task storage t = tasks[taskId];
        if (t.funder == address(0)) revert TaskNotOpen();
        if (t.funder != msg.sender) revert NotTaskFunder();
        if (t.settled) revert TaskAlreadySettled();
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
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

    /// @notice Destroy part of a user's custody and pay it to the task's
    /// publisher. The destination used to be a free `to` argument — a leaked
    /// arbitrator key could therefore redirect a worker's bond to itself. It
    /// is now hard-bound to `tasks[taskId].funder`, the only address slashing
    /// legitimately compensates, so the bond can never leave the task's
    /// two parties.
    function slashBond(
        address user,
        bytes32 taskId,
        uint256 amount
    ) external onlyArbitrator {
        if (amount == 0) revert ZeroAmount();
        Task storage t = tasks[taskId];
        if (t.funder == address(0)) revert TaskNotOpen();
        if (heldBondOf[user] < amount) revert InsufficientHeldBond();
        heldBondOf[user] -= amount;
        bondOf[user] -= amount;
        balanceOf[t.funder] += amount;
        emit BondSlashed(user, taskId, amount, t.funder);
    }

    // ── arbitrator: task money ────────────────────────────────────────────
    /// @notice Approved delivery: the escrowed bounty becomes the worker's
    /// spendable credits. The worker is the one bound by `assignWorker`, so
    /// the settlement target is no longer a free parameter — a leaked
    /// arbitrator key cannot redirect a bounty to itself. Bond occupancies are
    /// released separately.
    function settleTask(bytes32 taskId)
        external
        onlyArbitrator
    {
        Task storage t = tasks[taskId];
        if (t.settled) revert TaskAlreadySettled();
        address worker = t.worker;
        if (worker == address(0)) revert TaskNoWorker();
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
    /// `workerBond` is the amount the platform *wants* to slash out of the
    /// worker's custody. It is **clamped** to `heldBondOf[worker]` rather than
    /// rejected: the figure is computed off-chain and a stale one must not be
    /// able to keep a dispute open until a human notices. A clamp emits
    /// `BondSlashCapped` so the platform can reconcile its books; the amount
    /// actually applied is what `BondSlashed` and `TaskArbitrated` report.
    ///
    /// When `slashWorkerBond` is false the occupancy simply stays in place and
    /// the platform releases it with a separate `releaseBond` once the books
    /// agree.
    function arbitrateTask(
        bytes32 taskId,
        uint256 award,
        uint256 workerBond,
        bool slashWorkerBond
    ) external onlyArbitrator {
        Task storage t = tasks[taskId];
        if (t.settled) revert TaskAlreadySettled();
        address worker = t.worker;
        if (worker == address(0)) revert TaskNoWorker();
        uint256 amount = t.escrow;
        if (amount == 0) revert TaskNotFunded();
        if (award > amount) revert AwardTooLarge();

        uint256 slash = slashWorkerBond ? workerBond : 0;
        if (slash > heldBondOf[worker]) {
            emit BondSlashCapped(taskId, worker, workerBond, heldBondOf[worker]);
            slash = heldBondOf[worker];
        }

        t.settled = true;
        t.escrow = 0;
        if (award > 0) balanceOf[worker] += award;
        if (amount > award) balanceOf[t.funder] += amount - award;
        if (slash > 0) {
            heldBondOf[worker] -= slash;
            bondOf[worker] -= slash;
            balanceOf[t.funder] += slash;
            emit BondSlashed(worker, taskId, slash, t.funder);
        }
        // Reports the slash that actually happened, not the one requested.
        emit TaskArbitrated(taskId, worker, award, slash, t.funder);
    }
}
