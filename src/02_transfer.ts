/**
 * ZIPP — Sprint 1, Deliverable 1 (Part 2)
 * Transfer RLUSD from Importer → Supplier
 *
 * Run this AFTER:
 * 1. You've run 01_setup.ts (creates wallets + trust lines)
 * 2. You've funded the Importer wallet with RLUSD via https://tryrlusd.com/
 *
 * This is the core of what Zipp does — move RLUSD between two parties.
 * On testnet it takes 3-5 seconds. On mainnet, same speed, real money.
 */

import * as xrpl from "xrpl";
import * as fs from "fs";

// ─── Load saved credentials ────────────────────────────────────────────────
// We saved these in 01_setup.ts. This is how the two scripts talk to each other.
const CREDENTIALS_PATH = "./testnet_credentials.json";

interface WalletCredentials {
  address: string;
  seed: string;
  publicKey: string;
}

interface Credentials {
  testnetUrl: string;
  rlusdIssuer: string;
  rlusdCurrencyHex: string;
  importer: WalletCredentials;
  supplier: WalletCredentials;
}

async function main(): Promise<void> {
  // Check that credentials file exists
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error("❌ No credentials found. Run 01_setup.ts first:");
    console.error("   npx ts-node src/01_setup.ts");
    process.exit(1);
  }

  const creds: Credentials = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, "utf8")
  );

  console.log("\n══════════════════════════════════════════════════════");
  console.log("  ZIPP — RLUSD Transfer");
  console.log("══════════════════════════════════════════════════════\n");
  console.log(`  Importer: ${creds.importer.address}`);
  console.log(`  Supplier: ${creds.supplier.address}\n`);

  // ── Connect ─────────────────────────────────────────────────────────────
  const client = new xrpl.Client(creds.testnetUrl);
  await client.connect();
  console.log("📡 Connected to XRPL Testnet\n");

  // ── Restore wallets from seeds ──────────────────────────────────────────
  // We don't need to create new wallets — we just rebuild them from the
  // saved seeds. The seed is all you need to control a wallet.
  const importerWallet = xrpl.Wallet.fromSeed(creds.importer.seed);
  const supplierWallet = xrpl.Wallet.fromSeed(creds.supplier.seed);

  // ── Check Importer's RLUSD balance ──────────────────────────────────────
  // Before sending, let's make sure we actually have RLUSD to send.
  const importerLines = await client.request({
    command: "account_lines",
    account: importerWallet.address,
    ledger_index: "validated",
  });

  const rlusdLine = importerLines.result.lines.find(
    (line) => line.account === creds.rlusdIssuer
  );

  if (!rlusdLine || parseFloat(rlusdLine.balance) <= 0) {
    console.log("❌ No RLUSD balance found on Importer wallet.\n");
    console.log("   You need to get RLUSD from the faucet first:");
    console.log("   1. Go to https://tryrlusd.com/");
    console.log(`   2. Paste: ${importerWallet.address}`);
    console.log("   3. Select 'XRPL Testnet' and request tokens");
    console.log("   4. Wait ~10 seconds, then run this script again\n");
    await client.disconnect();
    return;
  }

  const currentBalance = parseFloat(rlusdLine.balance);
  console.log(`💰 Importer RLUSD balance: ${currentBalance}\n`);

  // ── Send RLUSD ──────────────────────────────────────────────────────────
  // This is a Payment transaction — the same transaction type used for XRP,
  // but with a structured Amount object instead of a simple number.
  //
  // The Amount object specifies:
  //   - currency: which token (RLUSD in hex)
  //   - value: how much to send
  //   - issuer: who issued the token
  //
  // This is exactly what happens when your father pays a supplier through Zipp.
  // The RLUSD moves from his wallet to the supplier's wallet in 3-5 seconds.

  const transferAmount = Math.min(100, currentBalance).toString();
  console.log(`📤 Sending ${transferAmount} RLUSD → Supplier...\n`);

  const paymentTx: xrpl.Payment = {
    TransactionType: "Payment",
    Account: importerWallet.address,
    Destination: supplierWallet.address,
    Amount: {
      currency: creds.rlusdCurrencyHex,
      value: transferAmount,
      issuer: creds.rlusdIssuer,
    },
  };

  // Same flow: autofill → sign → submit and wait
  const prepared = await client.autofill(paymentTx);
  const signed = importerWallet.sign(prepared);
  
  console.log("   ⏳ Submitting to XRPL and waiting for confirmation...");
  const result = await client.submitAndWait(signed.tx_blob);

  // ── Check result ────────────────────────────────────────────────────────
  if (
    result.result.meta &&
    typeof result.result.meta !== "string" &&
    result.result.meta.TransactionResult === "tesSUCCESS"
  ) {
    console.log(`\n   ✅ SUCCESS! ${transferAmount} RLUSD transferred!\n`);
    console.log(`   🔗 Transaction hash: ${signed.hash}`);
    console.log(`   🔗 View on explorer: https://testnet.xrpl.org/transactions/${signed.hash}\n`);

    // ── Verify final balances ───────────────────────────────────────────
    console.log("   Checking final balances...\n");

    const importerFinal = await client.request({
      command: "account_lines",
      account: importerWallet.address,
      ledger_index: "validated",
    });

    const supplierFinal = await client.request({
      command: "account_lines",
      account: supplierWallet.address,
      ledger_index: "validated",
    });

    const impBalance = importerFinal.result.lines.find(
      (l) => l.account === creds.rlusdIssuer
    );
    const supBalance = supplierFinal.result.lines.find(
      (l) => l.account === creds.rlusdIssuer
    );

    console.log("══════════════════════════════════════════════════════");
    console.log("  FINAL RLUSD BALANCES");
    console.log("══════════════════════════════════════════════════════");
    console.log(`  Importer: ${impBalance ? impBalance.balance : "0"} RLUSD`);
    console.log(`  Supplier: ${supBalance ? supBalance.balance : "0"} RLUSD`);
    console.log("══════════════════════════════════════════════════════\n");
    console.log("  🎉 Deliverable 1 COMPLETE!");
    console.log("  You just moved RLUSD between two wallets on the XRPL.");
    console.log("  This is the core payment rail that Zipp is built on.\n");
  } else {
    const txResult =
      result.result.meta && typeof result.result.meta !== "string"
        ? result.result.meta.TransactionResult
        : "Unknown error";
    console.error(`\n   ❌ Transfer failed: ${txResult}`);
  }

  await client.disconnect();
  console.log("📡 Disconnected. Done!\n");
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
