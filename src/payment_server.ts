/**
 * ZIPP — Payment API Server
 * Wraps the XRPL transfer logic as a REST endpoint.
 *
 * Run:
 *   npx ts-node src/payment_server.ts
 *
 * Endpoint:
 *   POST /pay  — Send RLUSD on testnet, return transaction hash
 *   GET /health — Check server is alive
 *   GET /balance — Check importer's current RLUSD balance
 */

import express from "express";
import cors from "cors";
import * as xrpl from "xrpl";
import * as fs from "fs";
import * as path from "path";

// ─── Load credentials ───────────────────────────────────────────────────────
const CREDENTIALS_PATH = path.join(__dirname, "..", "testnet_credentials.json");

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

if (!fs.existsSync(CREDENTIALS_PATH)) {
  console.error("❌ No testnet_credentials.json found at:", CREDENTIALS_PATH);
  console.error("   Run 01_setup.ts first: npx ts-node src/01_setup.ts");
  process.exit(1);
}

const creds: Credentials = JSON.parse(
  fs.readFileSync(CREDENTIALS_PATH, "utf8")
);

// ─── Express setup ──────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:3000", "http://localhost:8080"],
  })
);

// ─── POST /pay ──────────────────────────────────────────────────────────────
// The React app calls this when the accountant clicks "Confirm payment".
// It connects to XRPL testnet, sends RLUSD, and returns the transaction hash.
app.post("/pay", async (req, res) => {
  try {
    const { amount, invoiceId } = req.body;

    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const transferAmount = parseFloat(amount).toString();

    console.log(`\n💳 Payment request: ${transferAmount} RLUSD (Invoice: ${invoiceId || "N/A"})`);

    // Connect to XRPL testnet
    const client = new xrpl.Client(creds.testnetUrl);
    await client.connect();
    console.log("   📡 Connected to XRPL Testnet");

    // Restore wallets from saved seeds
    const importerWallet = xrpl.Wallet.fromSeed(creds.importer.seed);
    const supplierWallet = xrpl.Wallet.fromSeed(creds.supplier.seed);

    // Check balance before sending
    const importerLines = await client.request({
      command: "account_lines",
      account: importerWallet.address,
      ledger_index: "validated",
    });

    const rlusdLine = importerLines.result.lines.find(
      (line) => line.account === creds.rlusdIssuer
    );

    if (!rlusdLine || parseFloat(rlusdLine.balance) <= 0) {
      await client.disconnect();
      return res.status(400).json({
        error: "No RLUSD balance. Fund the importer wallet at https://tryrlusd.com/",
        walletAddress: importerWallet.address,
      });
    }

    const currentBalance = parseFloat(rlusdLine.balance);

    if (parseFloat(transferAmount) > currentBalance) {
      await client.disconnect();
      return res.status(400).json({
        error: `Insufficient balance. Have ${currentBalance} RLUSD, need ${transferAmount}`,
      });
    }

    // Build and send the RLUSD payment — same logic as 02_transfer.ts
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

    console.log("   ⏳ Submitting to XRPL...");
    const result = await client.submitAndWait(signed.tx_blob);

    // Check if the transaction succeeded
    const meta = result.result.meta;
    const txResult =
      meta && typeof meta !== "string" ? meta.TransactionResult : "Unknown";

    if (txResult === "tesSUCCESS") {
      // Get final balances
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

      const impBal = importerFinal.result.lines.find(
        (l) => l.account === creds.rlusdIssuer
      );
      const supBal = supplierFinal.result.lines.find(
        (l) => l.account === creds.rlusdIssuer
      );

      await client.disconnect();

      console.log(`   ✅ SUCCESS! ${transferAmount} RLUSD sent`);
      console.log(`   🔗 TX: ${signed.hash}\n`);

      return res.json({
        success: true,
        transactionHash: signed.hash,
        explorerUrl: `https://testnet.xrpl.org/transactions/${signed.hash}`,
        amount: transferAmount,
        balances: {
          importer: impBal ? impBal.balance : "0",
          supplier: supBal ? supBal.balance : "0",
        },
      });
    } else {
      await client.disconnect();
      console.log(`   ❌ Failed: ${txResult}`);
      return res.status(500).json({ error: `Transaction failed: ${txResult}` });
    }
  } catch (error: any) {
    console.error("   ❌ Payment error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ─── GET /balance ───────────────────────────────────────────────────────────
// Quick check of the importer's RLUSD balance
app.get("/balance", async (_req, res) => {
  try {
    const client = new xrpl.Client(creds.testnetUrl);
    await client.connect();

    const importerWallet = xrpl.Wallet.fromSeed(creds.importer.seed);
    const lines = await client.request({
      command: "account_lines",
      account: importerWallet.address,
      ledger_index: "validated",
    });

    const rlusdLine = lines.result.lines.find(
      (l) => l.account === creds.rlusdIssuer
    );

    await client.disconnect();

    return res.json({
      address: importerWallet.address,
      balance: rlusdLine ? rlusdLine.balance : "0",
      currency: "RLUSD",
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// ─── GET /health ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", credentials: CREDENTIALS_PATH });
});

// ─── Start server ───────────────────────────────────────────────────────────
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Zipp Payment API running on http://localhost:${PORT}`);
  console.log(`   Importer wallet: ${creds.importer.address}`);
  console.log(`   Supplier wallet: ${creds.supplier.address}\n`);
});
