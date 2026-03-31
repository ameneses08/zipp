"""
ZIPP — Invoice Extraction API
Wraps the existing 03_invoice_extractor.py pipeline as a REST endpoint.

Run:
  pip install fastapi uvicorn python-multipart
  uvicorn api_server:app --reload --port 8000

Endpoint:
  POST /extract
  - Body: multipart/form-data with field "file" (PDF or image)
  - Returns: JSON with extracted data + validation report
"""

import os
import tempfile
import shutil
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# Import extraction functions from existing pipeline
from invoice_extractor import (
    detect_and_decode_qr,
    extract_text_with_ocr,
    structure_with_gpt4o,
    merge_qr_and_ocr,
    validate_extraction,
)

app = FastAPI(title="Zipp Invoice Extractor API")

# Allow React dev server to call this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "http://localhost:8080"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/extract")
async def extract_invoice(file: UploadFile = File(...)):
    """
    Accept a PDF or image file, run the full extraction pipeline,
    return structured invoice data + validation report.
    """
    # Validate file type
    allowed_types = [
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/tiff",
        "image/webp",
    ]
    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {file.content_type}. Send a PDF or image.",
        )

    # Save upload to a temp file (OCR and QR detection need a file path)
    suffix = os.path.splitext(file.filename or "upload")[1] or ".pdf"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        shutil.copyfileobj(file.file, tmp)
        tmp.close()
        file_path = tmp.name

        # ── Tier 1: EPC QR ────────────────────────────────────────────
        qr_data = detect_and_decode_qr(file_path)

        # ── Tier 2: OCR + GPT-4o ─────────────────────────────────────
        raw_text, lang_used = extract_text_with_ocr(file_path)
        ocr_data = structure_with_gpt4o(raw_text, qr_data)

        # ── Merge ─────────────────────────────────────────────────────
        if qr_data:
            extracted = merge_qr_and_ocr(qr_data, ocr_data)
        else:
            extracted = ocr_data

        # ── Tier 3: Validate ──────────────────────────────────────────
        validation = validate_extraction(extracted, used_qr=bool(qr_data))

        return {
            "extracted": extracted,
            "validation": validation,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    finally:
        # Clean up temp file
        if os.path.exists(tmp.name):
            os.unlink(tmp.name)


@app.get("/health")
def health():
    return {"status": "ok"}
