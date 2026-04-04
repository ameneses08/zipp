// XRPL testnet wallet setup and RLUSD trust line configuration

import * as xrpl from "xrpl";
import * as fs from "fs";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";

const RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

// RLUSD is >3 chars so must be hex-encoded on XRPL
const RLUSD_HEX = "524C555344000000000000000000000000000000";

const TRUST_LIMIT = "1000000";

function getTxResult(result: xrpl.TxResponse): string {
  const meta = result.result.meta;
  if (meta && typeof meta !== "string") {
    return meta.TransactionResult;
  }
  return "UNKNOWN";
}

function findRlusdLine(lines: { account: string; currency: string; limit: string; balance: string }[]) {
  return lines.find(
    (line) => line.account === RLUSD_ISSUER && line.currency === RLUSD_HEX
  );
}

async function main(): Promise<void> {
  console.log("\nZIPP — XRPL Testnet Setup\n");

  console.log("Connecting to XRPL Testnet...");
  const client = new xrpl.Client(TESTNET_URL);
  await client.connect();
  console.log("Connected.\n");

  try {
    console.log("Creating Importer wallet...");
    const importerFundResult = await client.fundWallet();
    const importerWallet = importerFundResult.wallet;
    console.log(`   Address: ${importerWallet.address}`);
    console.log(`   Seed:    ${importerWallet.seed}`);
    console.log(`   Balance: ${importerFundResult.balance} XRP\n`);

    console.log("Creating Supplier wallet...");
    const supplierFundResult = await client.fundWallet();
    const supplierWallet = supplierFundResult.wallet;
    console.log(`   Address: ${supplierWallet.address}`);
    console.log(`   Seed:    ${supplierWallet.seed}`);
    console.log(`   Balance: ${supplierFundResult.balance} XRP\n`);

    console.log("Setting RLUSD trust line on Importer wallet...");

    const importerTrustTx: xrpl.TrustSet = {
      TransactionType: "TrustSet",
      Account: importerWallet.address,
      LimitAmount: {
        currency: RLUSD_HEX,
        issuer: RLUSD_ISSUER,
        value: TRUST_LIMIT,
      },
    };

    const importerTrustPrepared = await client.autofill(importerTrustTx);
    const importerTrustSigned = importerWallet.sign(importerTrustPrepared);
    const importerTrustResult = await client.submitAndWait(importerTrustSigned.tx_blob);

    if (getTxResult(importerTrustResult) !== "tesSUCCESS") {
      throw new Error(
        `Importer trust line failed: ${getTxResult(importerTrustResult)}`
      );
    }
    console.log("Importer RLUSD trust line set.\n");

    console.log("Setting RLUSD trust line on Supplier wallet...");

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
    console.log("Supplier RLUSD trust line set.\n");

    console.log("Verifying trust lines...");

    const importerLines = await client.request({
      command: "account_lines",
      account: importerWallet.address,
      ledger_index: "validated",
    });

    const importerRlusdLine = findRlusdLine(importerLines.result.lines);

    if (importerRlusdLine) {
      console.log(`   Importer: RLUSD trust line active (limit: ${importerRlusdLine.limit})`);
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
      console.log(`   Supplier: RLUSD trust line active (limit: ${supplierRlusdLine.limit})`);
    } else {
      throw new Error("Supplier RLUSD trust line not found after setting it!");
    }

    // Seeds saved in plain text — fine for testnet, never do this on mainnet
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

    console.log("\nSetup complete.\n");
    console.log("IMPORTER WALLET (Costa Rica importer)");
    console.log(`   Address: ${importerWallet.address}`);
    console.log(`   Seed:    ${importerWallet.seed}\n`);
    console.log("SUPPLIER WALLET (European supplier)");
    console.log(`   Address: ${supplierWallet.address}`);
    console.log(`   Seed:    ${supplierWallet.seed}\n`);
    console.log("RLUSD CONFIG");
    console.log(`   Issuer:  ${RLUSD_ISSUER}`);
    console.log(`   Hex:     ${RLUSD_HEX}\n`);
    console.log("Credentials saved to: testnet_credentials.json\n");
    console.log("View your wallets on the explorer:");
    console.log(`   Importer: https://testnet.xrpl.org/accounts/${importerWallet.address}`);
    console.log(`   Supplier: https://testnet.xrpl.org/accounts/${supplierWallet.address}\n`);
    console.log("NEXT STEP:");
    console.log("  1. Go to https://tryrlusd.com/");
    console.log(`  2. Paste this address: ${importerWallet.address}`);
    console.log("  3. Select 'XRPL Testnet' and request RLUSD tokens");
    console.log("  4. Then run: npx ts-node src/02_transfer.ts\n");

  } finally {
    await client.disconnect();
    console.log("Disconnected from XRPL Testnet.\n");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error.message || error);
  process.exit(1);
});
