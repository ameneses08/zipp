# Invoice extraction API wrapping the OCR/GPT-4o pipeline

import os
import tempfile
import shutil
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from invoice_extractor import (
    detect_and_decode_qr,
    extract_text_with_ocr,
    structure_with_gpt4o,
    merge_qr_and_ocr,
    validate_extraction,
)

app = FastAPI(title="Zipp Invoice Extractor API")

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

    suffix = os.path.splitext(file.filename or "upload")[1] or ".pdf"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        shutil.copyfileobj(file.file, tmp)
        tmp.close()
        file_path = tmp.name

        qr_data = detect_and_decode_qr(file_path)

        raw_text, lang_used = extract_text_with_ocr(file_path)
        ocr_data = structure_with_gpt4o(raw_text, qr_data)

        if qr_data:
            extracted = merge_qr_and_ocr(qr_data, ocr_data)
        else:
            extracted = ocr_data

        validation = validate_extraction(extracted, used_qr=bool(qr_data))

        return {
            "extracted": extracted,
            "validation": validation,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    finally:
        if os.path.exists(tmp.name):
            os.unlink(tmp.name)


@app.get("/health")
def health():
    return {"status": "ok"}
