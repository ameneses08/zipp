/**
 * ZIPP — Sprint 1, Deliverable 1
 * XRPL Testnet Setup: Create Wallets + Configure RLUSD Trust Lines
 * 
 * What this script does:
 * 1. Connects to the XRPL Testnet (a free practice blockchain)
 * 2. Creates two wallets: "Importer" (your father's company) and "Supplier" (European supplier)
 * 3. Sets up RLUSD trust lines on both wallets so they can hold RLUSD
 * 4. Saves all wallet credentials to a JSON file for later use
 */

// ─── Import the XRPL library ───────────────────────────────────────────────
// This is like importing a toolkit. The 'xrpl' library gives us functions
// to create wallets, send transactions, and interact with the ledger.
import * as xrpl from "xrpl";
import * as fs from "fs";

// ─── Configuration ──────────────────────────────────────────────────────────

// The testnet is a practice version of the real XRPL. Tokens here have zero value.
// We connect via WebSocket (wss://) — a persistent connection that lets us send
// and receive data in real time, like a phone call instead of sending letters.
const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";

// This is the official RLUSD issuer on testnet. On XRPL, every token (that isn't XRP)
// has an issuer — the account that created it. RLUSD is issued by Ripple.
// Think of it like: "I trust the Central Bank to issue dollars." Same idea.
const RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

// XRPL has a quirk: currency codes longer than 3 characters must be hex-encoded.
// "RLUSD" is 5 characters, so we convert it to hexadecimal and pad to 40 characters.
// R=52, L=4C, U=55, S=53, D=44 → "524C555344" + zeros to fill 40 chars
const RLUSD_HEX = "524C555344000000000000000000000000000000";

// The maximum amount of RLUSD we're willing to hold. This is part of the trust line —
// it's like telling the ledger "I'll accept up to 1,000,000 RLUSD from this issuer."
const TRUST_LIMIT = "1000000";

// ─── Helper: Extract transaction result safely ──────────────────────────────
// XRPL transaction results can come back in different formats.
// This helper safely extracts the result string (e.g., "tesSUCCESS").
function getTxResult(result: xrpl.TxResponse): string {
  const meta = result.result.meta;
  if (meta && typeof meta !== "string") {
    return meta.TransactionResult;
  }
  return "UNKNOWN";
}

// ─── Helper: Find RLUSD trust line in account lines ─────────────────────────
// Checks BOTH issuer AND currency to avoid false positives.
// (An account could theoretically have multiple tokens from the same issuer.)
function findRlusdLine(lines: { account: string; currency: string; limit: string; balance: string }[]) {
  return lines.find(
    (line) => line.account === RLUSD_ISSUER && line.currency === RLUSD_HEX
  );
}

// ─── Main Function ──────────────────────────────────────────────────────────
async function main(): Promise<void> {
  
  console.log("\n══════════════════════════════════════════════════════");
  console.log("  ZIPP — XRPL Testnet Setup");
  console.log("══════════════════════════════════════════════════════\n");

  // ── Step 1: Connect to the Testnet ──────────────────────────────────────
  // Create a "client" — our connection to the XRPL network.
  // This is like opening a phone line to the blockchain.
  console.log("Connecting to XRPL Testnet...");
  const client = new xrpl.Client(TESTNET_URL);
  await client.connect();
  console.log("✅ Connected!\n");

  // try/finally ensures we ALWAYS disconnect, even if something crashes.
  // Without this, a failed script would leave a zombie WebSocket connection open.
  try {

    // ── Step 2: Create two funded wallets ─────────────────────────────────
    // client.fundWallet() does three things at once:
    //   1. Generates a new key pair (address + secret seed)
    //   2. Asks the testnet faucet to send ~100 XRP to activate the account
    //   3. Returns the wallet object we can use to sign transactions
    //
    // On mainnet you'd need real XRP. On testnet, the faucet gives it for free.
    
    console.log("👛 Creating Importer wallet...");
    const importerFundResult = await client.fundWallet();
    const importerWallet = importerFundResult.wallet;
    console.log(`   Address: ${importerWallet.address}`);
    console.log(`   Seed:    ${importerWallet.seed}`);
    console.log(`   Balance: ${importerFundResult.balance} XRP\n`);

    console.log("👛 Creating Supplier wallet ...");
    const supplierFundResult = await client.fundWallet();
    const supplierWallet = supplierFundResult.wallet;
    console.log(`   Address: ${supplierWallet.address}`);
    console.log(`   Seed:    ${supplierWallet.seed}`);
    console.log(`   Balance: ${supplierFundResult.balance} XRP\n`);

    // ── Step 3: Set RLUSD trust lines ─────────────────────────────────────
    // Before a wallet can hold RLUSD, it MUST create a "trust line" to the issuer.
    // This is an XRPL safety feature — it prevents people from spamming your
    // wallet with random tokens you never asked for.
    //
    // A TrustSet transaction says: "I, [my address], trust [issuer] to issue
    // [currency] and I'll hold up to [limit] of it."
    //
    // Both wallets need this — the Importer (who will receive RLUSD from the faucet
    // and send payments) and the Supplier (who will receive RLUSD payments).

    console.log("🔗 Setting RLUSD trust line on Importer wallet...");
    
    // Build the transaction object. Every XRPL transaction has a TransactionType
    // and an Account (who is sending it). TrustSet also needs LimitAmount.
    const importerTrustTx: xrpl.TrustSet = {
      TransactionType: "TrustSet",
      Account: importerWallet.address,
      LimitAmount: {
        currency: RLUSD_HEX,       // What token we're trusting
        issuer: RLUSD_ISSUER,       // Who issues it
        value: TRUST_LIMIT,         // Max we'll hold
      },
    };

    // autofill() adds default fields the network needs (like fee and sequence number).
    // Think of it as the library filling out the boring parts of a form for you.
    const importerTrustPrepared = await client.autofill(importerTrustTx);
    
    // sign() uses our secret seed to cryptographically sign the transaction.
    // This proves we own the account — like signing a check.
    const importerTrustSigned = importerWallet.sign(importerTrustPrepared);
    
    // submitAndWait() sends the signed transaction to the network AND waits
    // until it's confirmed (included in a validated ledger). Usually 3-5 seconds.
    const importerTrustResult = await client.submitAndWait(importerTrustSigned.tx_blob);

    // FAIL FAST: If the trust line didn't set, there's no point continuing.
    // The rest of the script depends on both trust lines being active.
    if (getTxResult(importerTrustResult) !== "tesSUCCESS") {
      throw new Error(
        `Importer trust line failed: ${getTxResult(importerTrustResult)}`
      );
    }
    console.log("✅ Importer RLUSD trust line set!\n");

    // Now do the same for the Supplier wallet
    console.log("🔗 Setting RLUSD trust line on Supplier wallet...");
    
    const supplierTrustTx: xrpl.TrustSet = {
      TransactionType: "TrustSet",
      Account: supplierWallet.address,
      LimitAmount: {
        currency: RLUSD_HEX,
        issuer: RLUSD_ISSUER,
        value: TRUST_LIMIT,
      },
    };

    const supplierTrustPrepared = await client.autofill(supplierTrustTx);
    const supplierTrustSigned = supplierWallet.sign(supplierTrustPrepared);
    const supplierTrustResult = await client.submitAndWait(supplierTrustSigned.tx_blob);

    if (getTxResult(supplierTrustResult) !== "tesSUCCESS") {
      throw new Error(
        `Supplier trust line failed: ${getTxResult(supplierTrustResult)}`
      );
    }
    console.log("✅ Supplier RLUSD trust line set!\n");

    // ── Step 4: Verify trust lines ────────────────────────────────────────
    // Let's confirm the trust lines actually exist by querying the ledger.
    // account_lines returns all trust lines for an account.
    
    console.log("🔍 Verifying trust lines...");
    
    const importerLines = await client.request({
      command: "account_lines",
      account: importerWallet.address,
      ledger_index: "validated",
    });

    // We check BOTH issuer AND currency to be precise.
    const importerRlusdLine = findRlusdLine(importerLines.result.lines);

    if (importerRlusdLine) {
      console.log(`   Importer: ✅ RLUSD trust line active (limit: ${importerRlusdLine.limit})`);
    } else {
      throw new Error("Importer RLUSD trust line not found after setting it!");
    }

    const supplierLines = await client.request({
      command: "account_lines",
      account: supplierWallet.address,
      ledger_index: "validated",
    });

    const supplierRlusdLine = findRlusdLine(supplierLines.result.lines);

    if (supplierRlusdLine) {
      console.log(`   Supplier: ✅ RLUSD trust line active (limit: ${supplierRlusdLine.limit})`);
    } else {
      throw new Error("Supplier RLUSD trust line not found after setting it!");
    }

    // ── Step 5: Save credentials ──────────────────────────────────────────
    // Save everything to a JSON file so we can use these wallets in the next script.
    // NOTE: In a real app, seeds would NEVER be saved in plain text.
    // This is fine for testnet — these wallets have no real value.

    const credentials = {
      network: "XRPL Testnet",
      testnetUrl: TESTNET_URL,
      rlusdIssuer: RLUSD_ISSUER,
      rlusdCurrencyHex: RLUSD_HEX,
      importer: {
        address: importerWallet.address,
        seed: importerWallet.seed,
        publicKey: importerWallet.publicKey,
      },
      supplier: {
        address: supplierWallet.address,
        seed: supplierWallet.seed,
        publicKey: supplierWallet.publicKey,
      },
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync("./testnet_credentials.json", JSON.stringify(credentials, null, 2));

    // ── Summary ───────────────────────────────────────────────────────────
    console.log("\n══════════════════════════════════════════════════════");
    console.log("  SETUP COMPLETE — Save These!");
    console.log("══════════════════════════════════════════════════════\n");
    console.log("📋 IMPORTER WALLET (Costa Rica importer)");
    console.log(`   Address: ${importerWallet.address}`);
    console.log(`   Seed:    ${importerWallet.seed}\n`);
    console.log("📋 SUPPLIER WALLET (European supplier)");
    console.log(`   Address: ${supplierWallet.address}`);
    console.log(`   Seed:    ${supplierWallet.seed}\n`);
    console.log("📋 RLUSD CONFIG");
    console.log(`   Issuer:  ${RLUSD_ISSUER}`);
    console.log(`   Hex:     ${RLUSD_HEX}\n`);
    console.log("💾 Credentials saved to: testnet_credentials.json\n");
    console.log("🔗 View your wallets on the explorer:");
    console.log(`   Importer: https://testnet.xrpl.org/accounts/${importerWallet.address}`);
    console.log(`   Supplier: https://testnet.xrpl.org/accounts/${supplierWallet.address}\n`);
    console.log("══════════════════════════════════════════════════════");
    console.log("  NEXT STEP:");
    console.log("  1. Go to https://tryrlusd.com/");
    console.log(`  2. Paste this address: ${importerWallet.address}`);
    console.log("  3. Select 'XRPL Testnet' and request RLUSD tokens");
    console.log("  4. Then run: npx ts-node src/02_transfer.ts");
    console.log("══════════════════════════════════════════════════════\n");

  } finally {
    // This runs whether the script succeeded or crashed.
    // Always clean up your connections.
    await client.disconnect();
    console.log("📡 Disconnected from XRPL Testnet.\n");
  }
}

// Run the main function and catch any errors
main().catch((error) => {
  console.error("❌ Fatal error:", error.message || error);
  process.exit(1);
});
