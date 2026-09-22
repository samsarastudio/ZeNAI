import cv2
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "config" / "compositions"
model = Path(__file__).resolve().parent / "_models" / "face_detection_yunet_2023mar.onnx"
results = {}

for can in ["cool-mint", "wintergreen", "cinnamon", "spearmint", "citrus", "peppermint"]:
    img_path = root / can / "composition.jpg"
    img = cv2.imread(str(img_path))
    if img is None:
        print(can, "MISSING")
        continue
    h, w = img.shape[:2]
    detector = cv2.FaceDetectorYN_create(str(model), "", (w, h), 0.6, 0.3, 5000)
    detector.setInputSize((w, h))
    _, faces = detector.detect(img)
    candidates = []
    if faces is not None:
        for row in faces:
            x, y, fw, fh = [float(v) for v in row[:4]]
            score = float(row[-1]) if len(row) > 14 else 1.0
            cy = y + fh / 2
            if cy > h * 0.42:
                continue
            candidates.append((score * fw * fh, x, y, fw, fh, score))
    candidates.sort(reverse=True)
    print(f"{can}: {w}x{h} faces={0 if faces is None else len(faces)} upper={len(candidates)}")
    if not candidates:
        print("  NO FACE")
        continue
    _, x, y, fw, fh, score = candidates[0]
    # Expand to cover hair + chin for head-swap oval
    pad_x = fw * 0.28
    pad_top = fh * 0.72
    pad_bot = fh * 0.35
    x0 = max(0.0, x - pad_x)
    y0 = max(0.0, y - pad_top)
    x1 = min(float(w), x + fw + pad_x)
    y1 = min(float(h), y + fh + pad_bot)
    bw, bh = x1 - x0, y1 - y0
    face = {
        "xPercent": round(100 * x0 / w, 2),
        "yPercent": round(100 * y0 / h, 2),
        "widthPercent": round(100 * bw / w, 2),
        "heightPercent": round(100 * bh / h, 2),
    }
    results[can] = face
    print(
        "  score",
        round(score, 3),
        "->",
        face,
        "center",
        round(100 * (x0 + bw / 2) / w, 1),
        round(100 * (y0 + bh / 2) / h, 1),
    )

    # Preview overlay for verification
    preview = img.copy()
    cv2.rectangle(
        preview,
        (int(x0), int(y0)),
        (int(x1), int(y1)),
        (0, 255, 0),
        max(2, w // 400),
    )
    cv2.ellipse(
        preview,
        (int(x0 + bw / 2), int(y0 + bh / 2)),
        (int(bw / 2), int(bh / 2)),
        0,
        0,
        360,
        (0, 255, 255),
        max(2, w // 400),
    )
    out_img = root / can / "face-preview.jpg"
    cv2.imwrite(str(out_img), preview)

out = root / "_detected-faces.json"
out.write_text(json.dumps(results, indent=2), encoding="utf-8")
print("wrote", out)
