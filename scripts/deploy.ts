import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

/**
 * C4 deploy guard.
 *
 * The contract owner must be a Gnosis Safe (or any multi-sig) — never an EOA.
 * A leaked EOA owner could, in a single transaction, hand the arbitrator role
 * to an attacker via `proposeArbitrator` + `acceptArbitrator`; a Safe requires
 * 2-of-N signatures for every `pause` / `proposeArbitrator`. This script
 * refuses to deploy with an EOA owner, so the mistake can never reach a live
 * network.
 *
 * Run:
 *   npx hardhat run scripts/deploy.ts --network arbitrumSepolia   # testnet first
 *   npx hardhat run scripts/deploy.ts --network arbitrum          # mainnet
 *
 * Required env (see .env.example):
 *   DEPLOYER_PRIVATE_KEY   deployer wallet (pays gas)
 *   USDC_ADDRESS           Arbitrum USDC (mainnet 0xaf88d065e77c8cC2239327C5EDb3A432268e5831)
 *   OWNER_ADDRESS          Gnosis Safe address  ← must be a contract, not an EOA
 *   ARBITRATOR_ADDRESS     dedicated ops wallet (see README: it can no longer
 *                          redirect settlement, so a hot key is acceptable)
 */
async function main() {
  const network = process.env.HARDHAT_NETWORK || "hardhat";
  const usdc = (process.env.USDC_ADDRESS || "").trim();
  const owner = (process.env.OWNER_ADDRESS || "").trim();
  const arbitrator = (process.env.ARBITRATOR_ADDRESS || "").trim();

  for (const [name, v] of [
    ["USDC_ADDRESS", usdc],
    ["OWNER_ADDRESS", owner],
    ["ARBITRATOR_ADDRESS", arbitrator],
  ] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(v) || /^0x0{40}$/i.test(v)) {
      throw new Error(`Missing or invalid ${name}=${v || "(empty)"}`);
    }
  }

  // C4 enforcement: the owner must carry contract code (a Safe), not be an EOA.
  const code = await ethers.provider.getCode(owner);
  if (!code || code === "0x" || code === "0x0") {
    throw new Error(
      `OWNER_ADDRESS (${owner}) has no contract code. C4 requires the ` +
        `contract owner to be a Gnosis Safe (multi-sig), not an EOA. ` +
        `Refusing to deploy.`,
    );
  }

  const factory = await ethers.getContractFactory("HishmateEscrow");
  const escrow = await factory.deploy(usdc, arbitrator, owner);
  await escrow.waitForDeployment();
  const addr = await escrow.getAddress();
  console.log("HishmateEscrow deployed at", addr, "on", network);
  console.log(
    `Verify:\n  npx hardhat verify --network ${network} ${addr} ${usdc} ${arbitrator} ${owner}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
