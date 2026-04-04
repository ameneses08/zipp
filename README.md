# Zipp

**Cross-border payment automation for Latin American importers.**

Zipp automates the invoice-to-payment workflow for importing businesses that pay European and US suppliers. Upload a supplier invoice, extract payment details with AI, track due dates, and settle via XRPL — with the crypto layer completely invisible to end users.

Built for [Ripple's XRPL Student Builder Residency (Cohort 3)](https://xrpl.org/).

## How it works

1. **Invoice extraction** — Upload a supplier invoice (PDF or image). The pipeline detects EPC QR codes for instant field extraction, then runs OCR + GPT-4o to structure the remaining data. QR fields take priority over OCR output.

2. **Due date alerts** — Extracted invoices are stored in SQLite with status tracking: `pending → due_soon → overdue → paid`. The system generates alerts 7 days before due dates.

3. **Payment settlement** — When the accountant confirms a payment, Zipp converts local currency to RLUSD and settles on XRPL in 3-5 seconds. The supplier receives EUR or USD — no crypto visible on either end.

## Project structure

```
src/
  01_setup.ts              # XRPL testnet wallet + RLUSD trust line setup
  02_transfer.ts           # RLUSD payment between wallets
  invoice_extractor.py     # Tiered OCR + AI extraction pipeline
  04_invoice_alerts.ts     # Due date tracking + dashboard
docs/
  zipp-v3.html             # Landing page
sample-data/
  factura_extracted.json   # Example extractor output
```

## Setup

```bash
# Install Node dependencies
npm install

# Create a .env file with your OPENAI_API_KEY

# Run wallet setup (creates testnet wallets + RLUSD trust lines)
npx ts-node src/01_setup.ts

# Fund the importer wallet with RLUSD at https://tryrlusd.com/
# Then transfer RLUSD
npx ts-node src/02_transfer.ts

# Extract invoice data
python src/invoice_extractor.py your_invoice.pdf

# Run alerts demo
npx ts-node src/04_invoice_alerts.ts
```

## Tech stack

- **XRPL** + **RLUSD** — settlement layer
- **TypeScript** — wallets, payments, alerts, frontend
- **Python** — invoice extraction (pyzbar, OpenCV, Tesseract, GPT-4o)
- **SQLite** (better-sqlite3) — invoice storage
- **MoonPay** — on-ramp | **Me-Cash** — off-ramp

## Status

Live at [tryzipp.com](https://tryzipp.com). Built for Ripple's XRPL Student Builder Residency, Cohort 3.
