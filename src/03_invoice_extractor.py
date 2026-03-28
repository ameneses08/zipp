"""
ZIPP - Sprint 1, Deliverable 3
Invoice Extractor — Tiered Pipeline

Tier 1:  EPC QR detected → decode payment fields instantly (IBAN, BIC, amount, reference)
         Then ALWAYS run OCR+GPT-4o to fill gaps QR doesn't encode (dates, address, etc.)
         QR fields take priority over OCR where both are present.

Tier 2:  No QR → full OCR + GPT-4o for everything.

Tier 3:  Validate merged result, flag issues for human review.

Usage:
  python 03_invoice_extractor.py sample_invoice_qr.png     # QR + OCR fill
  python 03_invoice_extractor.py sample_invoice.png        # OCR only
  python 03_invoice_extractor.py spanish_invoice_no_iban.png
  python 03_invoice_extractor.py your_real_invoice.pdf
"""

import sys
import os
import json
import re
import pytesseract
import cv2
import numpy as np
from PIL import Image
from pyzbar import pyzbar
from openai import OpenAI
from dotenv import load_dotenv

# ── Config ────────────────────────────────────────────────────────────────────
load_dotenv()
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
MODEL = "gpt-4o"

REQUIRED_FIELDS = [
    "invoice_number",
    "invoice_date",
    "due_date",
    "currency",
    "total_amount",
    "supplier_name",
]

PAYMENT_ROUTING_FIELDS = [
    "iban",
    "routing_number",
    "account_number",
    "sort_code",
    "bic_swift",
]

# Fields the EPC QR standard encodes — these come from QR, not OCR
QR_AUTHORITATIVE_FIELDS = [
    "iban",
    "bic_swift",
    "total_amount",
    "currency",
    "payment_reference",
    "account_holder",
    "supplier_name",
    "payment_method",
]

PREFERRED_LANGUAGES = ["eng+spa+deu+fra", "eng+spa", "eng"]


# ══════════════════════════════════════════════════════════════════════════════
# TIER 1 — EPC QR Code
# ══════════════════════════════════════════════════════════════════════════════

def parse_epc_qr(payload: str) -> dict | None:
    lines = payload.strip().split("\n")
    if len(lines) < 7 or lines[0].strip() != "BCD" or lines[3].strip() != "SCT":
        return None

    def get(i):
        return lines[i].strip() if i < len(lines) else ""

    raw_amount = get(7)
    currency, amount = None, None
    if raw_amount:
        match = re.match(r"([A-Z]{3})([\d,\.]+)", raw_amount)
        if match:
            currency = match.group(1)
            amount = match.group(2).replace(",", "")

    raw_iban = get(6).replace(" ", "")
    iban_formatted = " ".join(raw_iban[i:i+4] for i in range(0, len(raw_iban), 4))

    return {
        "iban": iban_formatted or None,
        "bic_swift": get(4) or None,
        "account_holder": get(5) or None,
        "supplier_name": get(5) or None,
        "currency": currency,
        "total_amount": amount,
        "payment_reference": get(9) or get(10) or None,
        "payment_method": "IBAN",
    }


def detect_and_decode_qr(file_path: str) -> dict | None:
    ext = file_path.lower().split(".")[-1]

    if ext == "pdf":
        from pdf2image import convert_from_path
        pages = convert_from_path(file_path, dpi=200)
        images = [np.array(p.convert("RGB")) for p in pages]
    else:
        images = [np.array(Image.open(file_path).convert("RGB"))]

    for img_array in images:
        for scale in [1.0, 1.5, 2.0]:
            if scale != 1.0:
                h, w = img_array.shape[:2]
                resized = cv2.resize(img_array, (int(w * scale), int(h * scale)))
            else:
                resized = img_array

            gray = cv2.cvtColor(resized, cv2.COLOR_RGB2GRAY)
            for obj in pyzbar.decode(gray):
                if obj.type == "QRCODE":
                    try:
                        parsed = parse_epc_qr(obj.data.decode("utf-8"))
                        if parsed:
                            return parsed
                    except Exception:
                        continue
    return None


# ══════════════════════════════════════════════════════════════════════════════
# TIER 2 — OCR + GPT-4o
# ══════════════════════════════════════════════════════════════════════════════

def get_available_tesseract_lang() -> str:
    try:
        available = pytesseract.get_languages()
    except Exception:
        return "eng"
    for lang_combo in PREFERRED_LANGUAGES:
        if all(l in available for l in lang_combo.split("+")):
            return lang_combo
    return "eng"


def extract_text_with_ocr(file_path: str) -> tuple:
    lang = get_available_tesseract_lang()
    ext = file_path.lower().split(".")[-1]

    if ext == "pdf":
        from pdf2image import convert_from_path
        pages = convert_from_path(file_path, dpi=300)
        raw_text = ""
        for i, page in enumerate(pages):
            raw_text += f"\n--- PAGE {i+1} ---\n{pytesseract.image_to_string(page, lang=lang)}"
        return raw_text, lang
    else:
        img = Image.open(file_path)
        if img.width < 1000:
            scale = 1000 / img.width
            img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
        return pytesseract.image_to_string(img, lang=lang), lang


def build_system_prompt(qr_data: dict | None) -> str:
    base = """You are a payment data extraction assistant for an international accounts payable system.
Extract structured payment fields from raw OCR text of supplier invoices.
Invoices may be in any language (Spanish, German, French, English, etc.).

CRITICAL RULES:
- Extract ONLY information explicitly present in the text
- NEVER invent, guess, or fill in missing data — use null if not found
- For IBAN: preserve exact format including spaces
- For amounts: plain number string e.g. "5069.40" (no currency symbols)
- For dates: ISO format YYYY-MM-DD if possible, otherwise as-is
- For language: 2-letter code e.g. "es", "de", "fr", "en"
- For payment_method: "IBAN", "ACH", "SORT_CODE", "WIRE", or "UNKNOWN"

IMPORTANT — MULTIPLE BANK ACCOUNTS:
If the invoice contains more than one bank account or IBAN, extract ALL of them
into the bank_accounts array. Each entry should have: bank_name, iban, bic_swift,
account_holder. If only one account exists, still use the array with one entry.
"""

    if qr_data:
        confirmed = {k: v for k, v in qr_data.items() if v is not None}
        base += f"""
NOTE: The following fields were already extracted from a verified EPC QR code on this invoice.
Do NOT override these — they are authoritative. Focus on extracting the remaining fields:
{json.dumps(confirmed, indent=2, ensure_ascii=False)}

Fields you still need to find: invoice_number, invoice_date, due_date,
supplier_address, bank_accounts, language, and any others not listed above.
"""

    base += """
Return ONLY a valid JSON object — no markdown, no explanation:
{
  "language": string,
  "invoice_number": string or null,
  "invoice_date": string or null,
  "due_date": string or null,
  "currency": string or null,
  "total_amount": string or null,
  "supplier_name": string or null,
  "supplier_address": string or null,
  "payment_method": string,
  "bank_accounts": [
    {
      "bank_name": string or null,
      "account_holder": string or null,
      "iban": string or null,
      "bic_swift": string or null,
      "routing_number": string or null,
      "account_number": string or null,
      "sort_code": string or null
    }
  ],
  "payment_reference": string or null,
  "notes": string or null
}"""
    return base


def structure_with_gpt4o(raw_text: str, qr_data: dict | None) -> dict:
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": build_system_prompt(qr_data)},
            {"role": "user", "content": f"Extract payment fields from this invoice text:\n\n{raw_text}"}
        ],
        temperature=0,
        max_tokens=700,
    )
    raw = response.choices[0].message.content.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw)


def merge_qr_and_ocr(qr_data: dict, ocr_data: dict) -> dict:
    merged = {**ocr_data}
    for field in QR_AUTHORITATIVE_FIELDS:
        if qr_data.get(field):
            merged[field] = qr_data[field]
    # If QR provided a single IBAN, inject it into bank_accounts[0]
    if qr_data.get("iban") and merged.get("bank_accounts"):
        merged["bank_accounts"][0]["iban"] = qr_data["iban"]
        if qr_data.get("bic_swift"):
            merged["bank_accounts"][0]["bic_swift"] = qr_data["bic_swift"]
        if qr_data.get("account_holder"):
            merged["bank_accounts"][0]["account_holder"] = qr_data["account_holder"]
    return merged


# ══════════════════════════════════════════════════════════════════════════════
# ACCOUNT SELECTION — prompt user when multiple accounts found
# ══════════════════════════════════════════════════════════════════════════════

def select_bank_account(bank_accounts: list) -> dict:
    """
    If multiple bank accounts found, prompt the accountant to choose one.
    Returns the selected account dict.
    """
    if len(bank_accounts) == 1:
        return bank_accounts[0]

    print("\n  ⚠️  Multiple bank accounts found on this invoice.")
    print("  Please select which account to pay:\n")

    for i, account in enumerate(bank_accounts, 1):
        bank_name = account.get("bank_name") or "Unknown bank"
        iban = account.get("iban") or account.get("account_number") or "No IBAN"
        holder = account.get("account_holder") or ""
        print(f"  [{i}] {bank_name}")
        if holder:
            print(f"      Account holder: {holder}")
        print(f"      IBAN: {iban}")
        if account.get("bic_swift"):
            print(f"      BIC/SWIFT: {account['bic_swift']}")
        print()

    while True:
        try:
            choice = int(input(f"  Enter number (1-{len(bank_accounts)}): ").strip())
            if 1 <= choice <= len(bank_accounts):
                selected = bank_accounts[choice - 1]
                print(f"\n  ✅ Selected: {selected.get('bank_name') or 'Account'} — {selected.get('iban') or selected.get('account_number')}\n")
                return selected
            else:
                print(f"  Please enter a number between 1 and {len(bank_accounts)}.")
        except (ValueError, KeyboardInterrupt):
            print(f"  Invalid input. Please enter a number between 1 and {len(bank_accounts)}.")


def flatten_selected_account(data: dict, selected: dict) -> dict:
    """Flatten the chosen bank account fields back into the top-level extracted dict."""
    result = {k: v for k, v in data.items() if k != "bank_accounts"}
    result["bank_name"] = selected.get("bank_name")
    result["account_holder"] = selected.get("account_holder")
    result["iban"] = selected.get("iban")
    result["bic_swift"] = selected.get("bic_swift")
    result["routing_number"] = selected.get("routing_number")
    result["account_number"] = selected.get("account_number")
    result["sort_code"] = selected.get("sort_code")
    return result


# ══════════════════════════════════════════════════════════════════════════════
# TIER 3 — Validation
# ══════════════════════════════════════════════════════════════════════════════

def validate_extraction(data: dict, used_qr: bool) -> dict:
    issues = []
    warnings = []

    missing_required = [f for f in REQUIRED_FIELDS if not data.get(f)]
    if missing_required:
        issues.extend([f"Missing required field: {f}" for f in missing_required])

    found_routing = [f for f in PAYMENT_ROUTING_FIELDS if data.get(f)]
    if not found_routing:
        issues.append("No payment routing info found — manual entry required")
    elif not data.get("iban"):
        warnings.append(
            f"No IBAN found. Method: {data.get('payment_method', 'UNKNOWN')}. "
            f"Fields present: {', '.join(found_routing)}. Verify before processing."
        )

    if data.get("total_amount"):
        try:
            amount = float(data["total_amount"].replace(",", ""))
            if amount <= 0:
                issues.append("Total amount is zero or negative — verify invoice")
            elif amount > 1_000_000:
                warnings.append(f"Large payment: {amount:,.2f} — please verify")
        except ValueError:
            warnings.append(f"Could not parse total_amount: '{data['total_amount']}'")

    total_checks = len(REQUIRED_FIELDS) + 1
    passed = (len(REQUIRED_FIELDS) - len(missing_required)) + (1 if found_routing else 0)

    return {
        "status": "OK" if not issues else "REVIEW_NEEDED",
        "confidence": f"{passed / total_checks:.0%}",
        "extraction_method": "EPC_QR + OCR_GPT4O" if used_qr else "OCR_GPT4O",
        "payment_method_detected": data.get("payment_method", "UNKNOWN"),
        "issues": issues,
        "warnings": warnings,
        "requires_human_review": bool(issues or warnings),
    }


# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════

def main():
    if len(sys.argv) < 2:
        print("Usage: python 03_invoice_extractor.py <invoice_file>")
        sys.exit(1)

    file_path = sys.argv[1]
    if not os.path.exists(file_path):
        print(f"❌ File not found: {file_path}")
        sys.exit(1)

    print(f"\n{'═'*58}")
    print(f"  ZIPP Invoice Extractor — Tiered Pipeline")
    print(f"{'═'*58}")
    print(f"  File: {file_path}\n")

    # ── Tier 1: EPC QR ───────────────────────────────────────────────────────
    print("Tier 1 — Scanning for EPC QR code...")
    qr_data = detect_and_decode_qr(file_path)

    if qr_data:
        print("  ✅ EPC QR decoded — IBAN, BIC, amount, reference confirmed")
        print("  ○  Running OCR to fill missing fields (dates, address, etc.)\n")
    else:
        print("  ○  No EPC QR found\n")

    # ── Tier 2: OCR + GPT-4o (always runs) ───────────────────────────────────
    print("Tier 2 — Running Tesseract OCR...")
    raw_text, lang_used = extract_text_with_ocr(file_path)
    print(f"  ✅ {len(raw_text)} characters  |  Language pack: {lang_used}")
    preview = raw_text[:250].replace('\n', ' ').strip()
    print(f"  Preview: \"{preview}...\"\n")

    print("  Structuring with GPT-4o...")
    ocr_data = structure_with_gpt4o(raw_text, qr_data)
    print(f"  ✅ Done  |  Language detected: {ocr_data.get('language', 'unknown')}\n")

    # ── Merge ─────────────────────────────────────────────────────────────────
    if qr_data:
        extracted = merge_qr_and_ocr(qr_data, ocr_data)
        print("  ✅ Merged: QR payment fields + OCR document fields\n")
    else:
        extracted = ocr_data

    # ── Account selection ─────────────────────────────────────────────────────
    bank_accounts = extracted.get("bank_accounts") or []
    if bank_accounts:
        selected_account = select_bank_account(bank_accounts)
        extracted = flatten_selected_account(extracted, selected_account)
    else:
        # Fallback: old-style single account (no bank_accounts array returned)
        pass

    # ── Tier 3: Validate ──────────────────────────────────────────────────────
    print("Tier 3 — Validating...")
    validation = validate_extraction(extracted, used_qr=bool(qr_data))
    print(f"  Status:          {validation['status']}")
    print(f"  Confidence:      {validation['confidence']}")
    print(f"  Method:          {validation['extraction_method']}")
    print(f"  Payment method:  {validation['payment_method_detected']}")
    if validation["issues"]:
        for i in validation["issues"]:
            print(f"  ❌ {i}")
    if validation["warnings"]:
        for w in validation["warnings"]:
            print(f"  ⚠️  {w}")
    if not validation["issues"] and not validation["warnings"]:
        print("  ✅ All fields validated — ready for payment processing")
    print()

    # ── Output ────────────────────────────────────────────────────────────────
    print(f"{'═'*58}")
    print("  EXTRACTED PAYMENT DATA")
    print(f"{'═'*58}")
    print(json.dumps(extracted, indent=2, ensure_ascii=False))

    print(f"\n{'═'*58}")
    print("  VALIDATION REPORT")
    print(f"{'═'*58}")
    print(json.dumps(validation, indent=2, ensure_ascii=False))

    output_path = file_path.rsplit(".", 1)[0] + "_extracted.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({"extracted": extracted, "validation": validation}, f, indent=2, ensure_ascii=False)
    print(f"\n  💾 Saved to: {output_path}\n")


if __name__ == "__main__":
    main()
