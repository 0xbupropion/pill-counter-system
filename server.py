from __future__ import annotations

from io import BytesIO
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from PIL import Image, UnidentifiedImageError

from pill_analysis import PillAnalysisEngine


ROOT = Path(__file__).resolve().parent
app = Flask(__name__, static_folder=str(ROOT), static_url_path="")
engine = PillAnalysisEngine(ROOT)


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.get("/api/health")
def health():
    return jsonify(engine.health())


@app.post("/api/analyze-image")
def analyze_image():
    if "image" not in request.files:
        return jsonify({"ok": False, "error": "缺少 image 檔案欄位。"}), 400

    uploaded = request.files["image"]
    filename = uploaded.filename or "uploaded-image"
    raw = uploaded.read()
    if not raw:
        return jsonify({"ok": False, "error": "上傳的圖片是空的。"}), 400

    try:
        Image.open(BytesIO(raw)).verify()
    except (UnidentifiedImageError, OSError):
        return jsonify({"ok": False, "error": "檔案不是可辨識的圖片格式。"}), 400

    result = engine.analyze_image_bytes(raw, filename=filename)
    return jsonify(result)


@app.route("/api/analyze-image", methods=["OPTIONS"])
@app.route("/api/health", methods=["OPTIONS"])
def api_preflight():
    return ("", 204)


@app.get("/<path:path>")
def static_proxy(path: str):
    target = ROOT / path
    if target.is_file():
        return send_from_directory(ROOT, path)
    return send_from_directory(ROOT, "index.html")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8000, debug=True)
