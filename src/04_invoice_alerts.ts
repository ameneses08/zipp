/**
 * ZIPP — Sprint 1, Deliverable 4
 * Invoice Alert System
 *
 * Stores extracted invoices in SQLite, tracks due dates,
 * and generates alerts + dashboard summaries.
 *
 * Architecture:
 *   - SQLite via better-sqlite3 (local, zero-config, single file)
 *   - Consumes JSON output from 03_invoice_extractor.py
 *   - Standalone module — will be imported by the UI in Sprint 2/3
 *
 * Usage:
 *   npx ts-node 04_invoice_alerts.ts                  # run demo with sample data
 *   npx ts-node 04_invoice_alerts.ts path/to/extracted.json  # import real extraction
 *
 * Status lifecycle:
 *   pending → due_soon (7 days before) → overdue (past due) → paid
 *
 * NOTE: This file uses better-sqlite3 (npm install better-sqlite3)
 *       The Claude environment used sql.js for testing — same SQL, different API.
 *       On your machine with Cursor, better-sqlite3 is the one to use.
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ── Config ───────────────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, "zipp.db");
const ALERT_DAYS_BEFORE = 7; // "due_soon" triggers 7 days before due_date

// ── Types ────────────────────────────────────────────────────────────────────

// What the Python extractor outputs (after flattening)
interface ExtractedInvoice {
  language?: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  total_amount: string | null;
  supplier_name: string | null;
  supplier_address?: string | null;
  payment_method?: string;
  payment_reference?: string | null;
  bank_name?: string | null;
  account_holder?: string | null;
  iban?: string | null;
  bic_swift?: string | null;
  routing_number?: string | null;
  account_number?: string | null;
  sort_code?: string | null;
  notes?: string | null;
}

// What we store in the database
type InvoiceStatus = "pending" | "due_soon" | "overdue" | "paid";

interface StoredInvoice {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  total_amount: number | null;
  supplier_name: string | null;
  supplier_address: string | null;
  iban: string | null;
  bic_swift: string | null;
  payment_method: string | null;
  payment_reference: string | null;
  status: InvoiceStatus;
  created_at: string;
  paid_at: string | null;
}

interface Alert {
  id: string;
  invoice_number: string | null;
  supplier_name: string | null;
  total_amount: number | null;
  currency: string | null;
  due_date: string;
  days_until_due: number;
  urgency: "overdue" | "due_today" | "due_soon";
  message: string;
}

interface DashboardSummary {
  total_invoices: number;
  pending: number;
  due_soon: number;
  overdue: number;
  paid: number;
  total_amount_pending: number;
  total_amount_due_this_week: number;
  total_amount_overdue: number;
  currency_breakdown: Record<string, number>;
  next_due: StoredInvoice | null;
}


// ── Database Setup ───────────────────────────────────────────────────────────

function initDatabase(dbPath: string = DB_PATH): Database.Database {
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id                TEXT PRIMARY KEY,
      invoice_number    TEXT,
      invoice_date      TEXT,
      due_date          TEXT,
      currency          TEXT,
      total_amount      REAL,
      supplier_name     TEXT,
      supplier_address  TEXT,
      iban              TEXT,
      bic_swift         TEXT,
      payment_method    TEXT,
      payment_reference TEXT,
      status            TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'due_soon', 'overdue', 'paid')),
      created_at        TEXT DEFAULT (datetime('now')),
      paid_at           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);
    CREATE INDEX IF NOT EXISTS idx_invoices_supplier ON invoices(supplier_name);
  `);

  return db;
}


// ── Core Functions ───────────────────────────────────────────────────────────

/**
 * Save an extracted invoice to the database.
 * Accepts the JSON output from 03_invoice_extractor.py (post-flattening).
 */
function saveInvoice(db: Database.Database, extracted: ExtractedInvoice): StoredInvoice {
  const id = crypto.randomUUID();
  const amount = extracted.total_amount
    ? parseFloat(extracted.total_amount.replace(",", ""))
    : null;

  const stmt = db.prepare(`
    INSERT INTO invoices (id, invoice_number, invoice_date, due_date, currency, total_amount,
                          supplier_name, supplier_address, iban, bic_swift, payment_method,
                          payment_reference, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `);

  stmt.run(
    id,
    extracted.invoice_number,
    extracted.invoice_date,
    extracted.due_date,
    extracted.currency,
    amount,
    extracted.supplier_name,
    extracted.supplier_address || null,
    extracted.iban || null,
    extracted.bic_swift || null,
    extracted.payment_method || null,
    extracted.payment_reference || null
  );

  console.log(`  ✅ Invoice saved: ${extracted.supplier_name} — ${extracted.currency} ${extracted.total_amount} (due: ${extracted.due_date || "no date"})`);

  return getInvoice(db, id)!;
}


/**
 * Import an extracted JSON file (the _extracted.json output from the Python pipeline).
 */
function importFromExtractorOutput(db: Database.Database, filePath: string): StoredInvoice {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  // The extractor saves { extracted: {...}, validation: {...} }
  const extracted: ExtractedInvoice = raw.extracted || raw;
  return saveInvoice(db, extracted);
}


/**
 * Get a single invoice by ID.
 */
function getInvoice(db: Database.Database, id: string): StoredInvoice | null {
  const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
  return (row as StoredInvoice) || null;
}


/**
 * Get all invoices, optionally filtered by status.
 */
function getInvoices(db: Database.Database, status?: InvoiceStatus): StoredInvoice[] {
  if (status) {
    return db.prepare("SELECT * FROM invoices WHERE status = ? ORDER BY due_date ASC").all(status) as StoredInvoice[];
  }
  return db.prepare("SELECT * FROM invoices ORDER BY due_date ASC").all() as StoredInvoice[];
}


/**
 * Mark an invoice as paid. This is the human-in-the-loop confirmation step.
 */
function markAsPaid(db: Database.Database, id: string): StoredInvoice | null {
  db.prepare(`
    UPDATE invoices SET status = 'paid', paid_at = datetime('now') WHERE id = ?
  `).run(id);

  const invoice = getInvoice(db, id);
  if (invoice) {
    console.log(`  ✅ Marked as paid: ${invoice.supplier_name} — ${invoice.currency} ${invoice.total_amount}`);
  }
  return invoice;
}


/**
 * Update invoice statuses based on current date.
 * This is the core alert engine — call it on app start or periodically.
 *
 * Logic:
 *   - due_date is past today AND status != paid → overdue
 *   - due_date is within ALERT_DAYS_BEFORE days AND status == pending → due_soon
 */
function refreshStatuses(db: Database.Database): void {
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  // Calculate the "due_soon" threshold date
  const threshold = new Date();
  threshold.setDate(threshold.getDate() + ALERT_DAYS_BEFORE);
  const thresholdDate = threshold.toISOString().split("T")[0];

  // Mark overdue (past due, not paid)
  db.prepare(`
    UPDATE invoices
    SET status = 'overdue'
    WHERE due_date < ? AND status != 'paid' AND due_date IS NOT NULL
  `).run(today);

  // Mark due_soon (within 7 days, currently pending)
  db.prepare(`
    UPDATE invoices
    SET status = 'due_soon'
    WHERE due_date >= ? AND due_date <= ? AND status = 'pending' AND due_date IS NOT NULL
  `).run(today, thresholdDate);
}


/**
 * Generate alerts for invoices that need attention.
 * Returns sorted by urgency: overdue first, then due_today, then due_soon.
 */
function checkAlerts(db: Database.Database): Alert[] {
  // Refresh statuses first
  refreshStatuses(db);

  const today = new Date().toISOString().split("T")[0];

  const rows = db.prepare(`
    SELECT * FROM invoices
    WHERE status IN ('overdue', 'due_soon') AND due_date IS NOT NULL
    ORDER BY due_date ASC
  `).all() as StoredInvoice[];

  const alerts: Alert[] = rows.map((inv) => {
    const dueDate = new Date(inv.due_date!);
    const now = new Date(today);
    const diffMs = dueDate.getTime() - now.getTime();
    const daysUntilDue = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    let urgency: Alert["urgency"];
    let message: string;

    if (daysUntilDue < 0) {
      urgency = "overdue";
      message = `OVERDUE by ${Math.abs(daysUntilDue)} day${Math.abs(daysUntilDue) !== 1 ? "s" : ""} — ${inv.supplier_name} — ${inv.currency} ${inv.total_amount}`;
    } else if (daysUntilDue === 0) {
      urgency = "due_today";
      message = `DUE TODAY — ${inv.supplier_name} — ${inv.currency} ${inv.total_amount}`;
    } else {
      urgency = "due_soon";
      message = `Due in ${daysUntilDue} day${daysUntilDue !== 1 ? "s" : ""} — ${inv.supplier_name} — ${inv.currency} ${inv.total_amount}`;
    }

    return {
      id: inv.id,
      invoice_number: inv.invoice_number,
      supplier_name: inv.supplier_name,
      total_amount: inv.total_amount,
      currency: inv.currency,
      due_date: inv.due_date!,
      days_until_due: daysUntilDue,
      urgency,
      message,
    };
  });

  // Sort: overdue first, then due_today, then due_soon
  const urgencyOrder = { overdue: 0, due_today: 1, due_soon: 2 };
  alerts.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

  return alerts;
}


/**
 * Dashboard summary — everything the UI needs at a glance.
 */
function getDashboardSummary(db: Database.Database): DashboardSummary {
  // Refresh statuses first
  refreshStatuses(db);

  const all = getInvoices(db);
  const today = new Date();
  const weekFromNow = new Date();
  weekFromNow.setDate(weekFromNow.getDate() + 7);

  const pending = all.filter((i) => i.status === "pending");
  const dueSoon = all.filter((i) => i.status === "due_soon");
  const overdue = all.filter((i) => i.status === "overdue");
  const paid = all.filter((i) => i.status === "paid");

  const unpaid = all.filter((i) => i.status !== "paid");

  // Total pending = pending + due_soon (not yet paid, not yet overdue)
  const totalAmountPending = [...pending, ...dueSoon].reduce(
    (sum, i) => sum + (i.total_amount || 0), 0
  );

  // Due this week
  const todayStr = today.toISOString().split("T")[0];
  const weekStr = weekFromNow.toISOString().split("T")[0];
  const dueThisWeek = unpaid.filter(
    (i) => i.due_date && i.due_date >= todayStr && i.due_date <= weekStr
  );
  const totalAmountDueThisWeek = dueThisWeek.reduce(
    (sum, i) => sum + (i.total_amount || 0), 0
  );

  // Overdue total
  const totalAmountOverdue = overdue.reduce(
    (sum, i) => sum + (i.total_amount || 0), 0
  );

  // Currency breakdown (unpaid only)
  const currencyBreakdown: Record<string, number> = {};
  for (const inv of unpaid) {
    const cur = inv.currency || "UNKNOWN";
    currencyBreakdown[cur] = (currencyBreakdown[cur] || 0) + (inv.total_amount || 0);
  }

  // Next due invoice
  const nextDue = unpaid
    .filter((i) => i.due_date && i.due_date >= todayStr)
    .sort((a, b) => (a.due_date! > b.due_date! ? 1 : -1))[0] || null;

  return {
    total_invoices: all.length,
    pending: pending.length,
    due_soon: dueSoon.length,
    overdue: overdue.length,
    paid: paid.length,
    total_amount_pending: Math.round(totalAmountPending * 100) / 100,
    total_amount_due_this_week: Math.round(totalAmountDueThisWeek * 100) / 100,
    total_amount_overdue: Math.round(totalAmountOverdue * 100) / 100,
    currency_breakdown: currencyBreakdown,
    next_due: nextDue,
  };
}


// ── Exports (for Sprint 2/3 UI integration) ──────────────────────────────────

export {
  initDatabase,
  saveInvoice,
  importFromExtractorOutput,
  getInvoice,
  getInvoices,
  markAsPaid,
  refreshStatuses,
  checkAlerts,
  getDashboardSummary,
  ExtractedInvoice,
  StoredInvoice,
  Alert,
  DashboardSummary,
  InvoiceStatus,
};


// ══════════════════════════════════════════════════════════════════════════════
// Demo / CLI — Run this file directly to see it in action
// ══════════════════════════════════════════════════════════════════════════════

function printSection(title: string): void {
  console.log(`\n${"═".repeat(58)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(58)}`);
}

function runDemo(): void {
  console.log(`\n${"═".repeat(58)}`);
  console.log(`  ZIPP Invoice Alert System — Demo`);
  console.log(`${"═".repeat(58)}`);
  console.log(`  Today: ${new Date().toISOString().split("T")[0]}`);
  console.log(`  Alert threshold: ${ALERT_DAYS_BEFORE} days before due date\n`);

  // Use in-memory DB for demo (won't persist)
  const db = initDatabase(":memory:");

  // ── Sample invoices that simulate a real accountant's queue ─────────────

  const today = new Date();

  // Helper to create dates relative to today
  const daysFromNow = (n: number): string => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d.toISOString().split("T")[0];
  };

  const sampleInvoices: ExtractedInvoice[] = [
    {
      invoice_number: "INV-2025-0412",
      invoice_date: daysFromNow(-20),
      due_date: daysFromNow(-3),           // 3 days OVERDUE
      currency: "EUR",
      total_amount: "12450.00",
      supplier_name: "Schmidt Maschinenbau GmbH",
      iban: "DE89 3704 0044 0532 0130 00",
      bic_swift: "COBADEFFXXX",
      payment_method: "IBAN",
      payment_reference: "PO-CR-2025-0412",
    },
    {
      invoice_number: "INV-2025-0587",
      invoice_date: daysFromNow(-10),
      due_date: daysFromNow(0),            // DUE TODAY
      currency: "EUR",
      total_amount: "5069.40",
      supplier_name: "Olivetti Forniture S.r.l.",
      iban: "IT60 X054 2811 1010 0000 0123 456",
      bic_swift: "BPPIITRRXXX",
      payment_method: "IBAN",
      payment_reference: "2025/587",
    },
    {
      invoice_number: "INV-2025-0623",
      invoice_date: daysFromNow(-5),
      due_date: daysFromNow(4),            // Due in 4 days — DUE SOON
      currency: "EUR",
      total_amount: "8200.00",
      supplier_name: "Dubois et Fils SARL",
      iban: "FR76 3000 6000 0112 3456 7890 189",
      bic_swift: "AGRIFRPPXXX",
      payment_method: "IBAN",
      payment_reference: "FAC-2025-623",
    },
    {
      invoice_number: "INV-2025-0701",
      invoice_date: daysFromNow(-2),
      due_date: daysFromNow(25),           // Due in 25 days — PENDING (no alert)
      currency: "EUR",
      total_amount: "3150.75",
      supplier_name: "Van der Berg Logistics BV",
      iban: "NL91 ABNA 0417 1643 00",
      bic_swift: "ABNANL2AXXX",
      payment_method: "IBAN",
      payment_reference: "NL-2025-0701",
    },
    {
      invoice_number: "INV-2025-0455",
      invoice_date: daysFromNow(-30),
      due_date: daysFromNow(-15),          // 15 days OVERDUE
      currency: "GBP",
      total_amount: "6800.00",
      supplier_name: "Whitfield Industrial Supplies Ltd",
      iban: "GB29 NWBK 6016 1331 9268 19",
      bic_swift: "NWBKGB2LXXX",
      payment_method: "IBAN",
      payment_reference: "WIS-25-0455",
    },
  ];

  // ── Save all invoices ──────────────────────────────────────────────────

  printSection("SAVING INVOICES");
  for (const inv of sampleInvoices) {
    saveInvoice(db, inv);
  }

  // ── Check alerts ───────────────────────────────────────────────────────

  printSection("ALERTS");
  const alerts = checkAlerts(db);

  if (alerts.length === 0) {
    console.log("  No alerts — all invoices are on track.");
  } else {
    for (const alert of alerts) {
      const icon =
        alert.urgency === "overdue" ? "🔴" :
        alert.urgency === "due_today" ? "🟡" : "🟠";
      console.log(`  ${icon} ${alert.message}`);
    }
  }

  // ── Dashboard summary ──────────────────────────────────────────────────

  printSection("DASHBOARD SUMMARY");
  const summary = getDashboardSummary(db);

  console.log(`  Total invoices:     ${summary.total_invoices}`);
  console.log(`  Pending:            ${summary.pending}`);
  console.log(`  Due soon:           ${summary.due_soon}`);
  console.log(`  Overdue:            ${summary.overdue}`);
  console.log(`  Paid:               ${summary.paid}`);
  console.log();
  console.log(`  Amount pending:     ${summary.total_amount_pending.toLocaleString()}`);
  console.log(`  Due this week:      ${summary.total_amount_due_this_week.toLocaleString()}`);
  console.log(`  Amount overdue:     ${summary.total_amount_overdue.toLocaleString()}`);
  console.log();
  console.log(`  Currency breakdown:`);
  for (const [cur, amount] of Object.entries(summary.currency_breakdown)) {
    console.log(`    ${cur}: ${amount.toLocaleString()}`);
  }
  if (summary.next_due) {
    console.log(`\n  Next due: ${summary.next_due.supplier_name} — ${summary.next_due.currency} ${summary.next_due.total_amount} on ${summary.next_due.due_date}`);
  }

  // ── Simulate paying an invoice ─────────────────────────────────────────

  printSection("SIMULATING PAYMENT");
  const overdueInvoices = getInvoices(db, "overdue");
  if (overdueInvoices.length > 0) {
    const toPay = overdueInvoices[0];
    console.log(`  Accountant confirms payment for: ${toPay.supplier_name}`);
    console.log(`  → This would trigger XRPL RLUSD transfer via 02_transfer.ts`);
    markAsPaid(db, toPay.id);
  }

  // ── Updated dashboard after payment ────────────────────────────────────

  printSection("DASHBOARD AFTER PAYMENT");
  const updated = getDashboardSummary(db);
  console.log(`  Total invoices:     ${updated.total_invoices}`);
  console.log(`  Pending:            ${updated.pending}`);
  console.log(`  Due soon:           ${updated.due_soon}`);
  console.log(`  Overdue:            ${updated.overdue}`);
  console.log(`  Paid:               ${updated.paid}`);
  console.log(`  Amount overdue:     ${updated.total_amount_overdue.toLocaleString()}`);
  console.log();

  db.close();
}


// ── CLI entry point ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length > 0 && fs.existsSync(args[0])) {
  // Import mode: load an extracted JSON file
  const db = initDatabase();
  console.log(`\n  Importing: ${args[0]}`);
  importFromExtractorOutput(db, args[0]);

  console.log("\n  Current alerts:");
  const alerts = checkAlerts(db);
  for (const alert of alerts) {
    const icon =
      alert.urgency === "overdue" ? "🔴" :
      alert.urgency === "due_today" ? "🟡" : "🟠";
    console.log(`  ${icon} ${alert.message}`);
  }

  db.close();
} else {
  // Demo mode
  runDemo();
}
