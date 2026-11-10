import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { HishmateEscrow, MockUSDC } from "../typechain-types";

const U = (n: number) => BigInt(n) * 1_000_000n; // USDC base units (6 decimals)
const BOND_PUBLISHER = U(10);
const BOND_WORKER = U(5);
const TASK_ID = ethers.id("task-1");
const ARBITRATOR_DELAY = 2n * 86400n; // matches ARBITRATOR_DELAY in the contract

describe("HishmateEscrow", () => {
  async function fixture() {
    const [admin, arbitrator, publisher, worker, other] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const escrow = await (
      await ethers.getContractFactory("HishmateEscrow")
    ).deploy(await usdc.getAddress(), arbitrator.address, admin.address);
    // Everyone starts with credits on hand.
    for (const s of [publisher, worker, other]) {
      await usdc.mint(s.address, U(1000));
      await usdc.connect(s).approve(await escrow.getAddress(), U(1000));
    }
    return { usdc, escrow, admin, arbitrator, publisher, worker, other };
  }

  /** Solvency invariant: the contract holds exactly what the books say. */
  async function expectSolvent(
    usdc: MockUSDC,
    escrow: HishmateEscrow,
    users: string[],
  ) {
    let books = 0n;
    for (const u of users) {
      books += await escrow.balanceOf(u);
      books += await escrow.bondOf(u);
    }
    for (const id of [TASK_ID, ethers.id("task-2")]) {
      books += (await escrow.tasks(id)).escrow;
    }
    expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(books);
  }

  describe("credits", () => {
    it("deposits pull USDC in and credit balanceOf", async () => {
      const { usdc, escrow, publisher } = await loadFixture(fixture);
      await expect(escrow.connect(publisher).deposit(U(100)))
        .to.emit(escrow, "Deposited")
        .withArgs(publisher.address, U(100));
      expect(await escrow.balanceOf(publisher.address)).to.equal(U(100));
      expect(await usdc.balanceOf(publisher.address)).to.equal(U(900));
      await expectSolvent(usdc, escrow, [publisher.address]);
    });

    it("withdraw pays USDC out to the caller", async () => {
      const { usdc, escrow, publisher } = await loadFixture(fixture);
      await escrow.connect(publisher).deposit(U(100));
      await expect(escrow.connect(publisher).withdraw(U(40)))
        .to.emit(escrow, "Withdrawn")
        .withArgs(publisher.address, U(40));
      expect(await escrow.balanceOf(publisher.address)).to.equal(U(60));
      expect(await usdc.balanceOf(publisher.address)).to.equal(U(940));
      await expectSolvent(usdc, escrow, [publisher.address]);
    });

    it("withdrawFor lets the platform push a payout (platform pays gas)", async () => {
      const { usdc, escrow, arbitrator, publisher, other } = await loadFixture(fixture);
      await escrow.connect(publisher).deposit(U(100));
      await expect(
        escrow.connect(arbitrator).withdrawFor(publisher.address, U(30)),
      )
        .to.emit(escrow, "Withdrawn")
        .withArgs(publisher.address, U(30));
      expect(await usdc.balanceOf(publisher.address)).to.equal(U(930));
      // Only the arbitrator may push.
      await expect(
        escrow.connect(other).withdrawFor(publisher.address, U(1)),
      ).to.be.revertedWithCustomError(escrow, "NotArbitrator");
      await expectSolvent(usdc, escrow, [publisher.address]);
    });

    it("rejects withdrawing more than the balance", async () => {
      const { escrow, publisher } = await loadFixture(fixture);
      await escrow.connect(publisher).deposit(U(10));
      await expect(
        escrow.connect(publisher).withdraw(U(11)),
      ).to.be.revertedWithCustomError(escrow, "InsufficientBalance");
    });
  });

  describe("bond custody", () => {
    it("depositBond moves credits into custody without freezing per task", async () => {
      const { escrow, publisher } = await loadFixture(fixture);
      await escrow.connect(publisher).deposit(U(100));
      await escrow.connect(publisher).depositBond(U(20));
      expect(await escrow.bondOf(publisher.address)).to.equal(U(20));
      expect(await escrow.balanceOf(publisher.address)).to.equal(U(80));
      // Free custody is the eligibility number: 20 >= 10 → can publish.
      expect(await escrow.freeBondOf(publisher.address)).to.equal(U(20));
    });

    it("withdrawBond is blocked while a bond is occupied", async () => {
      const { escrow, arbitrator, publisher } = await loadFixture(fixture);
      await escrow.connect(publisher).deposit(U(100));
      await escrow.connect(publisher).depositBond(U(20));
      await escrow
        .connect(arbitrator)
        .holdBond(publisher.address, TASK_ID, BOND_PUBLISHER);
      await expect(
        escrow.connect(publisher).withdrawBond(U(1)),
      ).to.be.revertedWithCustomError(escrow, "BondOccupied");
      // Once released it works again — custody itself never left.
      await escrow
        .connect(arbitrator)
        .releaseBond(publisher.address, TASK_ID, BOND_PUBLISHER);
      await escrow.connect(publisher).withdrawBond(U(20));
      expect(await escrow.bondOf(publisher.address)).to.equal(0n);
      expect(await escrow.balanceOf(publisher.address)).to.equal(U(100));
    });

    it("holdBond refuses to over-occupy custody", async () => {
      const { escrow, arbitrator, publisher } = await loadFixture(fixture);
      await escrow.connect(publisher).deposit(U(100));
      await escrow.connect(publisher).depositBond(U(12));
      await expect(
        escrow
          .connect(arbitrator)
          .holdBond(publisher.address, TASK_ID, BOND_PUBLISHER + U(3)),
      ).to.be.revertedWithCustomError(escrow, "InsufficientFreeBond");
      await escrow
        .connect(arbitrator)
        .holdBond(publisher.address, TASK_ID, BOND_PUBLISHER);
      expect(await escrow.freeBondOf(publisher.address)).to.equal(U(2));
    });

    it("slashBond destroys custody and pays the counterparty", async () => {
      const { escrow, arbitrator, publisher, worker } = await loadFixture(fixture);
      for (const s of [publisher, worker]) {
        await escrow.connect(s).deposit(U(50));
        await escrow.connect(s).depositBond(s === publisher ? U(10) : U(5));
      }
      await escrow.connect(arbitrator).openTask(TASK_ID, publisher.address);
      await escrow.connect(arbitrator).holdBond(worker.address, TASK_ID, BOND_WORKER);
      // slashBond now hard-binds its destination to the task funder (the
      // publisher), so it can never be redirected to an attacker.
      await expect(
        escrow
          .connect(arbitrator)
          .slashBond(worker.address, TASK_ID, BOND_WORKER),
      )
        .to.emit(escrow, "BondSlashed")
        .withArgs(worker.address, TASK_ID, BOND_WORKER, publisher.address);
      expect(await escrow.bondOf(worker.address)).to.equal(0n);
      expect(await escrow.heldBondOf(worker.address)).to.equal(0n);
      // Publisher deposited U(50) then moved U(10) into custody.
      expect(await escrow.balanceOf(publisher.address)).to.equal(U(40) + BOND_WORKER);
      // Worker is no longer eligible to take work.
      expect(await escrow.freeBondOf(worker.address)).to.equal(0n);
    });
  });

  describe("task escrow", () => {
    async function funded() {
      const f = await loadFixture(fixture);
      const { escrow, publisher, worker, arbitrator } = f;
      await escrow.connect(publisher).deposit(U(100));
      await escrow.connect(publisher).depositBond(BOND_PUBLISHER);
      await escrow.connect(worker).deposit(U(50));
      await escrow.connect(worker).depositBond(BOND_WORKER);
      // The platform registers the publisher before any money moves; this is
      // what lets fundTask trust the caller.
      await escrow.connect(arbitrator).openTask(TASK_ID, publisher.address);
      await escrow.connect(publisher).fundTask(TASK_ID, U(60));
      // The worker is bound once the task is taken — this is what locks the
      // settlement target so a leaked arbitrator key cannot redirect funds.
      await escrow.connect(arbitrator).assignWorker(TASK_ID, worker.address);
      await escrow.connect(arbitrator).holdBond(publisher.address, TASK_ID, BOND_PUBLISHER);
      await escrow.connect(arbitrator).holdBond(worker.address, TASK_ID, BOND_WORKER);
      return f;
    }

    it("fundTask locks the bounty for the registered publisher only", async () => {
      const { escrow, arbitrator, publisher, other } = await loadFixture(fixture);
      await escrow.connect(publisher).deposit(U(100));
      await escrow.connect(arbitrator).openTask(TASK_ID, publisher.address);
      await expect(escrow.connect(publisher).fundTask(TASK_ID, U(60)))
        .to.emit(escrow, "TaskFunded")
        .withArgs(publisher.address, TASK_ID, U(60));
      expect((await escrow.tasks(TASK_ID)).escrow).to.equal(U(60));
      expect((await escrow.tasks(TASK_ID)).funder).to.equal(publisher.address);
      await escrow.connect(other).deposit(U(10));
      await expect(
        escrow.connect(other).fundTask(TASK_ID, U(5)),
      ).to.be.revertedWithCustomError(escrow, "NotTaskFunder");
    });

    it("an unregistered task id cannot be funded at all (griefing is closed)", async () => {
      // Regression: fundTask used to accept any caller for any task id, so a
      // stranger could lock a real task id with one unit of dust and leave the
      // real publisher reverting with NotTaskFunder from then on.
      const { escrow, other } = await loadFixture(fixture);
      await escrow.connect(other).deposit(U(10));
      await expect(
        escrow.connect(other).fundTask(TASK_ID, U(1)),
      ).to.be.revertedWithCustomError(escrow, "TaskNotOpen");
      expect((await escrow.tasks(TASK_ID)).funder).to.equal(ethers.ZeroAddress);
      expect((await escrow.tasks(TASK_ID)).escrow).to.equal(0n);
    });

    it("openTask refuses to re-point a task and is arbitrator-only", async () => {
      const { escrow, arbitrator, publisher, other } = await loadFixture(fixture);
      await escrow.connect(publisher).deposit(U(100));
      await expect(
        escrow.connect(other).openTask(TASK_ID, other.address),
      ).to.be.revertedWithCustomError(escrow, "NotArbitrator");
      await escrow.connect(arbitrator).openTask(TASK_ID, publisher.address);
      // Idempotent while it is the same publisher.
      await escrow.connect(arbitrator).openTask(TASK_ID, publisher.address);
      await escrow.connect(publisher).fundTask(TASK_ID, U(60));
      // Re-pointing after money landed would move the refund destination.
      await expect(
        escrow.connect(arbitrator).openTask(TASK_ID, other.address),
      ).to.be.revertedWithCustomError(escrow, "TaskAlreadyOpen");
      await expect(
        escrow.connect(arbitrator).openTask(TASK_ID, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("settleTask pays the escrow to the worker and frees both bonds", async () => {
      const { usdc, escrow, arbitrator, publisher, worker } = await funded();
      await escrow.connect(arbitrator).settleTask(TASK_ID);
      // Worker deposited U(50) then moved U(5) into custody.
      expect(await escrow.balanceOf(worker.address)).to.equal(U(45) + U(60));
      expect((await escrow.tasks(TASK_ID)).escrow).to.equal(0n);
      // Bonds were occupied, not spent — releasing restores full custody.
      await escrow.connect(arbitrator).releaseBond(publisher.address, TASK_ID, BOND_PUBLISHER);
      await escrow.connect(arbitrator).releaseBond(worker.address, TASK_ID, BOND_WORKER);
      expect(await escrow.bondOf(publisher.address)).to.equal(BOND_PUBLISHER);
      expect(await escrow.bondOf(worker.address)).to.equal(BOND_WORKER);
      expect(await escrow.freeBondOf(publisher.address)).to.equal(BOND_PUBLISHER);
      await expectSolvent(usdc, escrow, [publisher.address, worker.address]);
    });

    it("refundTask returns the escrow to the funder", async () => {
      const { usdc, escrow, arbitrator, publisher, worker } = await funded();
      await escrow.connect(arbitrator).refundTask(TASK_ID);
      // Publisher deposited U(100), moved U(10) into custody, funded U(60).
      expect(await escrow.balanceOf(publisher.address)).to.equal(U(90));
      await escrow.connect(arbitrator).releaseBond(publisher.address, TASK_ID, BOND_PUBLISHER);
      await escrow.connect(arbitrator).releaseBond(worker.address, TASK_ID, BOND_WORKER);
      await expectSolvent(usdc, escrow, [publisher.address, worker.address]);
    });

    it("arbitrateTask splits the escrow and slashes the worker bond", async () => {
      const { usdc, escrow, arbitrator, publisher, worker } = await funded();
      await escrow
        .connect(arbitrator)
        .arbitrateTask(TASK_ID, U(10), BOND_WORKER, true);
      // Award 10 to the worker, 50 back to the publisher, worker bond gone.
      // Worker: U(50) - U(5) custody + U(10) award. Publisher: U(100) - U(10)
      // custody - U(60) escrow + U(50) refund + U(5) slashed bond.
      expect(await escrow.balanceOf(worker.address)).to.equal(U(55));
      expect(await escrow.balanceOf(publisher.address)).to.equal(U(85));
      expect(await escrow.bondOf(worker.address)).to.equal(0n);
      expect(await escrow.bondOf(publisher.address)).to.equal(BOND_PUBLISHER);
      // Arbitration only touches the worker bond; the publisher's
      // occupancy stays until the platform releases it explicitly.
      expect(await escrow.freeBondOf(publisher.address)).to.equal(0n);
      await escrow
        .connect(arbitrator)
        .releaseBond(publisher.address, TASK_ID, BOND_PUBLISHER);
      expect(await escrow.freeBondOf(publisher.address)).to.equal(BOND_PUBLISHER);
      await expectSolvent(usdc, escrow, [publisher.address, worker.address]);
    });

    it("arbitrateTask can keep the worker bond instead of slashing it", async () => {
      const { escrow, arbitrator, worker } = await funded();
      await escrow
        .connect(arbitrator)
        .arbitrateTask(TASK_ID, U(60), BOND_WORKER, false);
      expect(await escrow.bondOf(worker.address)).to.equal(BOND_WORKER);
      expect(await escrow.heldBondOf(worker.address)).to.equal(BOND_WORKER);
    });

    it("arbitrateTask clamps a stale workerBond instead of blocking the dispute", async () => {
      // Regression: the size check used to revert with BondTooLarge, so a
      // figure the backend had already forgotten about could keep a dispute
      // open indefinitely. It is now capped to what the worker actually holds,
      // and both the cap and the applied amount are on the record.
      const { escrow, arbitrator, publisher, worker } = await funded();
      await expect(
        escrow
          .connect(arbitrator)
          .arbitrateTask(TASK_ID, U(10), BOND_WORKER + U(1), true),
      )
        .to.emit(escrow, "BondSlashCapped")
        .withArgs(TASK_ID, worker.address, BOND_WORKER + U(1), BOND_WORKER)
        .and.to.emit(escrow, "TaskArbitrated")
        .withArgs(TASK_ID, worker.address, U(10), BOND_WORKER, publisher.address);
      expect(await escrow.bondOf(worker.address)).to.equal(0n);
      expect(await escrow.heldBondOf(worker.address)).to.equal(0n);
      expect((await escrow.tasks(TASK_ID)).settled).to.equal(true);
    });

    it("arbitrateTask ignores workerBond when the bond is kept", async () => {
      // Exactly the reported bug: the check ran before the slashWorkerBond
      // branch, so an oversized figure reverted even though nothing was to be
      // slashed.
      const { escrow, arbitrator, worker } = await funded();
      await escrow
        .connect(arbitrator)
        .arbitrateTask(TASK_ID, U(60), BOND_WORKER + U(1000), false);
      expect(await escrow.bondOf(worker.address)).to.equal(BOND_WORKER);
      expect(await escrow.heldBondOf(worker.address)).to.equal(BOND_WORKER);
    });

    it("rejects settling an unfunded or already-settled task", async () => {
      const { escrow, arbitrator, worker } = await loadFixture(fixture);
      // open + assign but no funding yet → the escrow is empty
      await escrow.connect(worker).deposit(U(50));
      await escrow.connect(arbitrator).openTask(TASK_ID, worker.address);
      await escrow.connect(arbitrator).assignWorker(TASK_ID, worker.address);
      await expect(
        escrow.connect(arbitrator).settleTask(TASK_ID),
      ).to.be.revertedWithCustomError(escrow, "TaskNotFunded");
      await escrow.connect(worker).fundTask(TASK_ID, U(30));
      await escrow.connect(arbitrator).settleTask(TASK_ID);
      await expect(
        escrow.connect(arbitrator).settleTask(TASK_ID),
      ).to.be.revertedWithCustomError(escrow, "TaskAlreadySettled");
    });

    it("settlement and slash cannot target an arbitrary or zero address", async () => {
      // settleTask / arbitrateTask / slashBond no longer take a destination
      // argument at all: the worker comes from assignWorker and the slash
      // destination is the task funder. The only remaining zero-address guard
      // on a payout path is withdrawFor.
      const { usdc, escrow, arbitrator, publisher, worker } = await funded();
      // Slashing a task that was never opened must revert, and the slash can
      // never be steered to the zero address because the destination is the
      // task's publisher.
      await expect(
        escrow
          .connect(arbitrator)
          .slashBond(worker.address, ethers.id("nope"), BOND_WORKER),
      ).to.be.revertedWithCustomError(escrow, "TaskNotOpen");
      await expect(
        escrow.connect(arbitrator).withdrawFor(ethers.ZeroAddress, U(1)),
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      // Nothing above moved a unit.
      expect(await escrow.bondOf(worker.address)).to.equal(BOND_WORKER);
      expect(await escrow.balanceOf(publisher.address)).to.equal(U(30));
      await expectSolvent(usdc, escrow, [publisher.address, worker.address]);
    });

    it("settleTask / arbitrateTask revert until a worker is assigned", async () => {
      // A leaked arbitrator key that tries to settle or arbitrate a task
      // before its worker is bound gets TaskNoWorker — it cannot name the
      // recipient, because the contract does.
      const { usdc, escrow, arbitrator, publisher, worker } = await loadFixture(fixture);
      await escrow.connect(publisher).deposit(U(100));
      await escrow.connect(publisher).depositBond(BOND_PUBLISHER);
      await escrow.connect(arbitrator).openTask(TASK_ID, publisher.address);
      await escrow.connect(publisher).fundTask(TASK_ID, U(60));
      await escrow.connect(arbitrator).holdBond(publisher.address, TASK_ID, BOND_PUBLISHER);
      await expect(
        escrow.connect(arbitrator).settleTask(TASK_ID),
      ).to.be.revertedWithCustomError(escrow, "TaskNoWorker");
      await expect(
        escrow.connect(arbitrator).arbitrateTask(TASK_ID, U(10), 0n, false),
      ).to.be.revertedWithCustomError(escrow, "TaskNoWorker");
      // Once the worker is bound both paths open.
      await escrow.connect(worker).deposit(U(50));
      await escrow.connect(worker).depositBond(BOND_WORKER);
      await escrow.connect(arbitrator).assignWorker(TASK_ID, worker.address);
      await escrow.connect(arbitrator).holdBond(worker.address, TASK_ID, BOND_WORKER);
      await escrow.connect(arbitrator).settleTask(TASK_ID);
      expect((await escrow.tasks(TASK_ID)).settled).to.equal(true);
      await expectSolvent(usdc, escrow, [publisher.address, worker.address]);
    });

    it("rejects an award larger than the escrow", async () => {
      const { escrow, arbitrator, publisher, worker } = await funded();
      await expect(
        escrow
          .connect(arbitrator)
          .arbitrateTask(TASK_ID, U(61), BOND_WORKER, false),
      ).to.be.revertedWithCustomError(escrow, "AwardTooLarge");
    });

    it("assignWorker binds the worker once and refuses misuse", async () => {
      const { escrow, arbitrator, publisher, worker, other } = await loadFixture(fixture);
      // Must open first.
      await expect(
        escrow.connect(arbitrator).assignWorker(TASK_ID, worker.address),
      ).to.be.revertedWithCustomError(escrow, "TaskNotOpen");
      await escrow.connect(arbitrator).openTask(TASK_ID, publisher.address);
      // Zero address refused.
      await expect(
        escrow.connect(arbitrator).assignWorker(TASK_ID, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      // First binding succeeds.
      await escrow.connect(arbitrator).assignWorker(TASK_ID, worker.address);
      expect((await escrow.tasks(TASK_ID)).worker).to.equal(worker.address);
      // Cannot reassign.
      await expect(
        escrow.connect(arbitrator).assignWorker(TASK_ID, other.address),
      ).to.be.revertedWithCustomError(escrow, "WorkerAlreadySet");
    });

    it("assignWorker refuses after settlement", async () => {
      const { escrow, arbitrator, other } = await funded();
      await escrow.connect(arbitrator).settleTask(TASK_ID);
      await expect(
        escrow.connect(arbitrator).assignWorker(TASK_ID, other.address),
      ).to.be.revertedWithCustomError(escrow, "TaskAlreadySettled");
    });
  });

  describe("access control and pause", () => {
    it("only the arbitrator moves task money", async () => {
      const { escrow, other } = await loadFixture(fixture);
      await expect(
        escrow.connect(other).settleTask(TASK_ID),
      ).to.be.revertedWithCustomError(escrow, "NotArbitrator");
      await expect(
        escrow.connect(other).holdBond(other.address, TASK_ID, U(1)),
      ).to.be.revertedWithCustomError(escrow, "NotArbitrator");
    });

    it("the owner proposes the arbitrator with a delay, then accepts; non-owners cannot", async () => {
      const { escrow, admin, arbitrator, publisher, other } = await loadFixture(fixture);
      // Proposing does not change the live arbitrator.
      await escrow.connect(admin).proposeArbitrator(other.address);
      expect(await escrow.arbitrator()).to.equal(arbitrator.address);
      // Accepting before the delay reverts — this is the window a leaked owner
      // has to be vetoed in (or for monitoring to flag it).
      await expect(
        escrow.connect(admin).acceptArbitrator(),
      ).to.be.revertedWithCustomError(escrow, "ArbitratorChangeTooEarly");
      // After the delay it lands.
      await time.increase(ARBITRATOR_DELAY + 1n);
      await escrow.connect(admin).acceptArbitrator();
      expect(await escrow.arbitrator()).to.equal(other.address);
      // pause still works for the owner
      await escrow.connect(publisher).deposit(U(10));
      await escrow.connect(admin).pause();
      await expect(
        escrow.connect(publisher).withdraw(U(1)),
      ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
      await escrow.connect(admin).unpause();
      await escrow.connect(publisher).withdraw(U(10));
      // Non-owners cannot pause or propose.
      await expect(escrow.connect(publisher).pause()).to.be.revertedWithCustomError(
        escrow,
        "OwnableUnauthorizedAccount",
      );
      await expect(
        escrow.connect(publisher).proposeArbitrator(publisher.address),
      ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("cancelArbitratorChange vetoes a pending handover", async () => {
      const { escrow, admin, arbitrator, other } = await loadFixture(fixture);
      await escrow.connect(admin).proposeArbitrator(other.address);
      await escrow.connect(admin).cancelArbitratorChange();
      // Cancelled: still the old arbitrator, and accept now reverts (no pending).
      expect(await escrow.arbitrator()).to.equal(arbitrator.address);
      await expect(
        escrow.connect(admin).acceptArbitrator(),
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("refuses an arbitrator of the zero address", async () => {
      // With no proxy this would strand every payout path permanently.
      const { escrow, admin, usdc } = await loadFixture(fixture);
      await expect(
        escrow.connect(admin).proposeArbitrator(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      expect(await escrow.arbitrator()).to.not.equal(ethers.ZeroAddress);
      const factory = await ethers.getContractFactory("HishmateEscrow");
      await expect(
        factory.deploy(await usdc.getAddress(), ethers.ZeroAddress, admin.address),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  describe("self-audit hardening (conservation + state machine + pause)", () => {
    // Mirrors the `funded()` helper from the "task escrow" block so this suite
    // is self-contained at the outer describe scope.
    async function funded() {
      const f = await loadFixture(fixture);
      const { escrow, publisher, worker, arbitrator } = f;
      await escrow.connect(publisher).deposit(U(100));
      await escrow.connect(publisher).depositBond(BOND_PUBLISHER);
      await escrow.connect(worker).deposit(U(50));
      await escrow.connect(worker).depositBond(BOND_WORKER);
      await escrow.connect(arbitrator).openTask(TASK_ID, publisher.address);
      await escrow.connect(publisher).fundTask(TASK_ID, U(60));
      await escrow.connect(arbitrator).assignWorker(TASK_ID, worker.address);
      await escrow.connect(arbitrator).holdBond(publisher.address, TASK_ID, BOND_PUBLISHER);
      await escrow.connect(arbitrator).holdBond(worker.address, TASK_ID, BOND_WORKER);
      return f;
    }

    // ① Conservation: every operation leaves the contract solvent. Walks the
    // full lifecycle and re-checks the invariant after each step, so a
    // silently minted or burned unit of USDC fails loudly (Nordin step 1).
    it("stays solvent through the whole credit/bond/task lifecycle", async () => {
      const { usdc, escrow, admin, arbitrator, publisher, worker, other } =
        await loadFixture(fixture);
      const users = [publisher.address, worker.address, other.address];

      await escrow.connect(publisher).deposit(U(200));
      await expectSolvent(usdc, escrow, users);
      await escrow.connect(publisher).depositBond(BOND_PUBLISHER);
      await expectSolvent(usdc, escrow, users);
      await escrow.connect(worker).deposit(U(100));
      await escrow.connect(worker).depositBond(BOND_WORKER);
      await expectSolvent(usdc, escrow, users);

      await escrow.connect(arbitrator).openTask(TASK_ID, publisher.address);
      await escrow.connect(publisher).fundTask(TASK_ID, U(60));
      await expectSolvent(usdc, escrow, users);
      await escrow.connect(arbitrator).assignWorker(TASK_ID, worker.address);
      await escrow.connect(arbitrator).holdBond(publisher.address, TASK_ID, BOND_PUBLISHER);
      await escrow.connect(arbitrator).holdBond(worker.address, TASK_ID, BOND_WORKER);
      await expectSolvent(usdc, escrow, users);

      // Platform pushes a payout on the worker's behalf.
      await escrow.connect(arbitrator).withdrawFor(worker.address, U(10));
      await expectSolvent(usdc, escrow, users);

      // Slash the worker bond to the publisher, then release the publisher hold.
      await escrow.connect(arbitrator).slashBond(worker.address, TASK_ID, BOND_WORKER);
      await expectSolvent(usdc, escrow, users);
      await escrow.connect(arbitrator).releaseBond(publisher.address, TASK_ID, BOND_PUBLISHER);
      await expectSolvent(usdc, escrow, users);

      // Settle the bounty to the worker.
      await escrow.connect(arbitrator).settleTask(TASK_ID);
      await expectSolvent(usdc, escrow, users);

      // Cash out and pull bond back.
      await escrow.connect(worker).withdraw(U(20));
      await escrow.connect(publisher).withdrawBond(BOND_PUBLISHER);
      await expectSolvent(usdc, escrow, users);

      // Pause blocks further user withdrawals (guard, not conservation).
      await escrow.connect(admin).pause();
      await expect(
        escrow.connect(worker).withdraw(U(1)),
      ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
      await escrow.connect(admin).unpause();
      await expectSolvent(usdc, escrow, users);
    });

    // ② State machine: a task can only be closed once — no double-pay or lock
    // (Nordin step 2). Every money-moving path must reject a settled task.
    it("a settled task rejects every further money-moving call", async () => {
      const { usdc, escrow, arbitrator, publisher, worker } = await funded();
      await escrow.connect(arbitrator).settleTask(TASK_ID);
      await expect(
        escrow.connect(arbitrator).settleTask(TASK_ID),
      ).to.be.revertedWithCustomError(escrow, "TaskAlreadySettled");
      await expect(
        escrow.connect(arbitrator).refundTask(TASK_ID),
      ).to.be.revertedWithCustomError(escrow, "TaskAlreadySettled");
      await expect(
        escrow.connect(arbitrator).arbitrateTask(TASK_ID, U(10), 0n, false),
      ).to.be.revertedWithCustomError(escrow, "TaskAlreadySettled");
      await expect(
        escrow.connect(publisher).fundTask(TASK_ID, U(1)),
      ).to.be.revertedWithCustomError(escrow, "TaskAlreadySettled");
      await expect(
        escrow.connect(arbitrator).openTask(TASK_ID, publisher.address),
      ).to.be.revertedWithCustomError(escrow, "TaskAlreadySettled");
      await expectSolvent(usdc, escrow, [publisher.address, worker.address]);
    });

    it("an arbitrated task also rejects settle / refund / open", async () => {
      const { usdc, escrow, arbitrator, publisher, worker } = await funded();
      await escrow
        .connect(arbitrator)
        .arbitrateTask(TASK_ID, U(10), BOND_WORKER, true);
      await expect(
        escrow.connect(arbitrator).settleTask(TASK_ID),
      ).to.be.revertedWithCustomError(escrow, "TaskAlreadySettled");
      await expect(
        escrow.connect(arbitrator).refundTask(TASK_ID),
      ).to.be.revertedWithCustomError(escrow, "TaskAlreadySettled");
      await expectSolvent(usdc, escrow, [publisher.address, worker.address]);
    });

    it("fundTask can top up but never mints or loses USDC", async () => {
      const { usdc, escrow, arbitrator, publisher, worker } = await loadFixture(fixture);
      await escrow.connect(publisher).deposit(U(100));
      await escrow.connect(arbitrator).openTask(TASK_ID, publisher.address);
      await escrow.connect(publisher).fundTask(TASK_ID, U(40));
      await escrow.connect(publisher).fundTask(TASK_ID, U(20));
      expect((await escrow.tasks(TASK_ID)).escrow).to.equal(U(60));
      expect(await escrow.balanceOf(publisher.address)).to.equal(U(40));
      await expectSolvent(usdc, escrow, [publisher.address, worker.address]);
    });

    it("holdBond / slashBond refuse to exceed custody", async () => {
      const { usdc, escrow, arbitrator, publisher, worker } = await funded();
      await expect(
        escrow.connect(arbitrator).holdBond(publisher.address, TASK_ID, BOND_PUBLISHER + U(1)),
      ).to.be.revertedWithCustomError(escrow, "InsufficientFreeBond");
      await expect(
        escrow.connect(arbitrator).slashBond(worker.address, TASK_ID, BOND_WORKER + U(1)),
      ).to.be.revertedWithCustomError(escrow, "InsufficientHeldBond");
      await expectSolvent(usdc, escrow, [publisher.address, worker.address]);
    });

    // ③ Pause must guard every user-facing value-moving entry point
    // (Nordin step 3). Only `withdraw` was covered before; check them all.
    it("pause blocks withdraw, withdrawFor, deposit, fundTask, depositBond, withdrawBond", async () => {
      const { escrow, admin, arbitrator, publisher } = await funded();
      await escrow.connect(admin).pause();
      await expect(
        escrow.connect(publisher).withdraw(U(1)),
      ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
      await expect(
        escrow.connect(arbitrator).withdrawFor(publisher.address, U(1)),
      ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
      await expect(
        escrow.connect(publisher).deposit(U(1)),
      ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
      await expect(
        escrow.connect(publisher).fundTask(TASK_ID, U(1)),
      ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
      await expect(
        escrow.connect(publisher).depositBond(BOND_PUBLISHER),
      ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
      await expect(
        escrow.connect(publisher).withdrawBond(BOND_PUBLISHER),
      ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
      // Unpausing restores access.
      await escrow.connect(admin).unpause();
      await escrow.connect(publisher).withdraw(U(10));
    });

    // ③ withdrawFor can only move a user's own balance, and only by the arbitrator.
    it("withdrawFor cannot over-drain or be called by a non-arbitrator", async () => {
      const { escrow, arbitrator, publisher, other } = await funded();
      await expect(
        escrow.connect(arbitrator).withdrawFor(publisher.address, U(1000)),
      ).to.be.revertedWithCustomError(escrow, "InsufficientBalance");
      await expect(
        escrow.connect(other).withdrawFor(publisher.address, U(1)),
      ).to.be.revertedWithCustomError(escrow, "NotArbitrator");
    });
  });
});
