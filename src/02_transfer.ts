// Transfer RLUSD from Importer to Supplier on XRPL testnet

import * as xrpl from "xrpl";
import * as fs from "fs";

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
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error("No credentials found. Run 01_setup.ts first:");
    console.error("   npx ts-node src/01_setup.ts");
    process.exit(1);
  }

  const creds: Credentials = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, "utf8")
  );

  console.log("\nZIPP — RLUSD Transfer\n");
  console.log(`  Importer: ${creds.importer.address}`);
  console.log(`  Supplier: ${creds.supplier.address}\n`);

  const client = new xrpl.Client(creds.testnetUrl);
  await client.connect();
  console.log("Connected to XRPL Testnet\n");

  const importerWallet = xrpl.Wallet.fromSeed(creds.importer.seed);
  const supplierWallet = xrpl.Wallet.fromSeed(creds.supplier.seed);

  const importerLines = await client.request({
    command: "account_lines",
    account: importerWallet.address,
    ledger_index: "validated",
  });

  const rlusdLine = importerLines.result.lines.find(
    (line) => line.account === creds.rlusdIssuer
  );

  if (!rlusdLine || parseFloat(rlusdLine.balance) <= 0) {
    console.log("No RLUSD balance found on Importer wallet.\n");
    console.log("   You need to get RLUSD from the faucet first:");
    console.log("   1. Go to https://tryrlusd.com/");
    console.log(`   2. Paste: ${importerWallet.address}`);
    console.log("   3. Select 'XRPL Testnet' and request tokens");
    console.log("   4. Wait ~10 seconds, then run this script again\n");
    await client.disconnect();
    return;
  }

  const currentBalance = parseFloat(rlusdLine.balance);
  console.log(`Importer RLUSD balance: ${currentBalance}\n`);

  const transferAmount = Math.min(100, currentBalance).toString();
  console.log(`Sending ${transferAmount} RLUSD to Supplier...\n`);

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

  const prepared = await client.autofill(paymentTx);
  const signed = importerWallet.sign(prepared);

  console.log("   Submitting to XRPL and waiting for confirmation...");
  const result = await client.submitAndWait(signed.tx_blob);

  if (
    result.result.meta &&
    typeof result.result.meta !== "string" &&
    result.result.meta.TransactionResult === "tesSUCCESS"
  ) {
    console.log(`\n   Transfer complete: ${transferAmount} RLUSD\n`);
    console.log(`   Transaction hash: ${signed.hash}`);
    console.log(`   View on explorer: https://testnet.xrpl.org/transactions/${signed.hash}\n`);

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

    console.log("FINAL RLUSD BALANCES");
    console.log(`  Importer: ${impBalance ? impBalance.balance : "0"} RLUSD`);
    console.log(`  Supplier: ${supBalance ? supBalance.balance : "0"} RLUSD\n`);
  } else {
    const txResult =
      result.result.meta && typeof result.result.meta !== "string"
        ? result.result.meta.TransactionResult
        : "Unknown error";
    console.error(`\n   Transfer failed: ${txResult}`);
  }

  await client.disconnect();
  console.log("Disconnected.\n");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
