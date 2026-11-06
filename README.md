# HishmateEscrow

Custody contract for the [Hishmate](https://hishmate.com) freelance task
platform. USDC (6 decimals) on **Arbitrum One**.

Hishmate itself has been live on Arbitrum One mainnet since October 2026,
custodying real USDC. Today that custody runs through the platform's treasury
path; this contract is the **user-self-custody mode** — it activates the day
the platform sets an `ESCROW_ADDRESS`, after which users move their own money
with their own wallets and the platform only verifies what happened.

It is the on-chain half of a **custodial** design: the platform keeps an
internal ledger that mirrors every event emitted here, and the backend verifies
those events before it credits or moves a single internal unit.

---

## ⚠️ Status

| | |
|---|---|
| Security audit | **None** |
| Deployments | **None — not on any network** |
| Upgradeability | **None (no proxy)** |

This code has **not been audited** and is **not deployed**. Do not send funds to
any address claiming to be this contract. Read [Trust model](#trust-model)
before building on it.

---

## Trust model — read this first

**This is a custodial contract, not a trustless escrow.**

The `arbitrator` role — held by the platform — can:

| Function | What it can do |
|---|---|
| `openTask(taskId, publisher)` | Bind a task id to the wallet allowed to fund it |
| `settleTask(taskId, worker)` | Send a task's escrow to **any** address it names as worker |
| `refundTask(taskId)` | Return the escrow to the funder |
| `arbitrateTask(...)` | Split an escrow and slash a worker's bond |
| `holdBond / releaseBond` | Occupy or free any user's bond |
| `slashBond(user, taskId, amount, to)` | Destroy part of any user's bond and credit it to **any** address |

There is **no on-chain dispute process, no timelock, and no multi-sig
requirement at contract level**. The contract enforces *conservation*
(`held <= bond`, no double settlement, no overdraft) — it does **not** enforce
*fairness*. Fairness is the platform's off-chain promise.

**If you deploy this, the arbitrator key is the trust anchor.** Compromise it
and every balance in the contract is at risk. Use a hardware wallet or a
multi-sig as the arbitrator, and treat `pause()` as your incident response.

We publish this because users deposit real money into it and should be able to
read exactly what they are agreeing to — not because it removes the need to
trust us.

---

## Money model

Three buckets per user, mirroring the platform's internal ledger 1:1:

- **`balanceOf`** — spendable credits. Top up with `deposit`, cash out with
  `withdraw` (user pays gas) or `withdrawFor` (platform pays gas, so a user
  with no ETH can still exit).
- **`bondOf`** — bond in long-term custody. Deposited **once**; it is *not*
  re-frozen per task. `freeBondOf` above the platform's configured thresholds
  is what makes a user eligible to publish or take work. Those thresholds are
  enforced off-chain — the contract only reports the numbers.
- **`heldBondOf`** — the part of `bondOf` currently occupied by live tasks.
  `freeBondOf = bondOf - heldBondOf` is the eligibility number.

Task bounties live separately in `tasks[taskId].escrow`. Each task id also
records the **publisher** the platform registered with `openTask`, which is the
only wallet allowed to fund it — see [Task funding](#task-funding).

Bond occupancy is **role-agnostic on purpose**: `holdBond` does not care whether
the holder is the publisher or the worker. The platform knows the roles; the
contract only enforces conservation and emits task-tagged events the backend
matches against its own ledger.

### Gas policy

Users pay for the calls they make themselves (`deposit`, `withdraw`,
`fundTask`). The arbitrator pays for `openTask` and settlement, and the
publisher pre-pays that cost off-chain as a gas reserve — so a worker who is
owed money never needs ETH.

### Task funding

A task id is a public identifier, so it cannot by itself authorise funding:
`fundTask` used to accept any caller and lock in the first payer, which meant
one unit of dust on a real task id would leave the real publisher reverting
with `NotTaskFunder` forever.

The platform therefore registers the publisher first:

```
arbitrator: openTask(taskId, publisher)   // once, when the task opens
publisher:  fundTask(taskId, amount)      // only from that wallet
```

`openTask` is one arbitrator call per task and can share a transaction batch
with the publisher's `holdBond`. It is idempotent for the same publisher,
refuses to re-point a task, and refuses `address(0)`. `fundTask` on an
unregistered id reverts with `TaskNotOpen`, so guessing or scraping an id is
worth nothing.

---

## Design notes

- **Checks–effects–interactions** throughout; `ReentrancyGuard` on every
  user-facing money path.
- **Custom errors** instead of revert strings (cheaper, and callers can match
  them).
- **`SafeERC20`** for all transfers — no assumption that USDC behaves ideally.
- **Solidity 0.8.24**, so arithmetic overflow reverts natively; the explicit
  `bondOf - heldBondOf` checks exist to produce *meaningful* errors rather than
  a bare panic.
- **`Pausable`** covers user entry points. Arbitrator functions stay live while
  paused so the platform can still settle or refund during an incident.
- **Not upgradeable.** There is no proxy. A future hardened version means a new
  deployment plus a migration, not an in-place fix — before the platform points
  `ESCROW_ADDRESS` at an instance of this contract, it should be audited.

## Known trade-offs

These are deliberate, not oversights, but an auditor will ask:

1. `settleTask` lets the arbitrator name *any* worker address. The contract
   cannot know who actually did the work.
2. `slashBond` credits an arbitrary `to` address — used for counterparty
   compensation, but it is a powerful primitive.
3. Arbitrator functions are intentionally **not** `whenNotPaused`, so
   settlement continues during a pause.
4. ~~`fundTask` lets anyone fund, but the first funder for a `taskId` is locked
   in.~~ **Fixed**: `openTask` binds the publisher on chain, and `fundTask`
   rejects everyone else with `NotTaskFunder`. See
   [Task funding](#task-funding).
5. `arbitrateTask` **clamps** `workerBond` to `heldBondOf[worker]` instead of
   reverting. A stale figure from the backend must not be able to keep a
   dispute open; the clamp emits `BondSlashCapped`, and both `BondSlashed` and
   `TaskArbitrated` report the amount actually applied, not the amount asked
   for. The platform reconciles against those two events.
6. Settlement and slash destinations reject `address(0)` — with no proxy, a
   typo there would burn the money permanently.

---

## Usage

```bash
npm install
npm run build     # hardhat compile
npm test          # hardhat test
```

`test/escrow.test.ts` covers the conservation invariants: deposits, bond
occupancy, settlement, refunds, arbitration splits and slashing.

Deployment scripts are not included — the platform deploys through its own
pipeline. If you deploy, set `DEPLOYER_PRIVATE_KEY` and the relevant RPC URL
(see `hardhat.config.ts`), and **use a dedicated deployer key, never a funded
personal one**.

### Environment

| Variable | Purpose |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | Deployer account. Never commit this. |
| `ARBITRUM_ONE_RPC_URL` | Arbitrum One mainnet RPC. |

---

## License

MIT — see [LICENSE](./LICENSE).
