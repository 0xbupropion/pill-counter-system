from __future__ import annotations

import base64
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps
from scipy import ndimage as ndi


@dataclass
class RegionCandidate:
    area: int
    bbox: tuple[int, int, int, int]
    aspect_ratio: float
    fill_ratio: float
    centroid: tuple[float, float]
    split_count: int
    confidence: float


class OptionalTorchClassifier:
    def __init__(self, _project_root: Path):
        self.ready = False
        self.status = "雲端版本未載入正式分類模型，改用強化分割與外型推估。"

    def ensure_loaded(self) -> bool:
        return False

    def classify(self, _crop: Image.Image) -> dict[str, Any]:
        return {
            "model_ready": False,
            "pill_name": None,
            "confidence": None,
            "status": self.status,
        }


class PillAnalysisEngine:
    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.classifier = OptionalTorchClassifier(project_root)
        self.max_input_side = 1600
        self.min_region_area_ratio = 0.00018

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "modelReady": False,
            "modelStatus": self.classifier.status,
            "pipeline": [
                "border-aware foreground separation",
                "contrast enhancement",
                "distance-map overlap split",
                "same-scene pill-like object filtering",
            ],
        }

    def analyze_image_bytes(self, raw: bytes, filename: str = "uploaded-image") -> dict[str, Any]:
        image = Image.open(BytesIO(raw))
        image = ImageOps.exif_transpose(image).convert("RGB")
        image = self._resize_image(image)

        rgb = np.asarray(image, dtype=np.uint8)
        candidates = self._segment_candidates(rgb)

        items: list[dict[str, Any]] = []
        total_count = 0

        for index, candidate in enumerate(candidates, start=1):
            crop = self._crop_region(image, candidate.bbox, padding_ratio=0.16)
            model_result = self.classifier.classify(crop)
            total_count += candidate.split_count
            items.append(
                {
                    "index": index,
                    "bbox": {
                        "left": candidate.bbox[1],
                        "top": candidate.bbox[0],
                        "right": candidate.bbox[3],
                        "bottom": candidate.bbox[2],
                    },
                    "pillName": model_result["pill_name"],
                    "confidence": candidate.confidence,
                    "shapeSummary": {
                        "aspectRatio": round(candidate.aspect_ratio, 2),
                        "solidity": round(candidate.fill_ratio, 2),
                        "extent": round(candidate.fill_ratio, 2),
                    },
                    "status": model_result["status"],
                    "pieces": candidate.split_count,
                }
            )

        annotated = self._build_annotated_image(image, items)

        return {
            "ok": True,
            "sourceFile": filename,
            "totalCount": total_count,
            "items": items,
            "annotatedImage": annotated,
            "modelReady": False,
            "modelStatus": self.classifier.status,
            "notes": [
                "這版只統計同一畫面裡像藥丸或藥品的顆粒數，不再分錠劑、膠囊、針頭。",
                "背景接近時會綜合背景色差、局部對比與邊緣；重疊時會用距離圖估計分裂數量。",
            ],
            "debug": {
                "regions": len(items),
                "imageWidth": image.width,
                "imageHeight": image.height,
            },
        }

    def _resize_image(self, image: Image.Image) -> Image.Image:
        longest_side = max(image.size)
        if longest_side <= self.max_input_side:
            return image

        scale = self.max_input_side / float(longest_side)
        next_size = (max(1, int(image.width * scale)), max(1, int(image.height * scale)))
        return image.resize(next_size, Image.Resampling.LANCZOS)

    def _segment_candidates(self, rgb: np.ndarray) -> list[RegionCandidate]:
        rgb_float = rgb.astype(np.float32) / 255.0
        gray = (
            0.299 * rgb_float[:, :, 0]
            + 0.587 * rgb_float[:, :, 1]
            + 0.114 * rgb_float[:, :, 2]
        )
        enhanced_gray = self._normalize(ndi.gaussian_filter(gray, sigma=0.8) - ndi.gaussian_filter(gray, sigma=4.2))

        border_pixels = np.concatenate(
            [
                rgb_float[0, :, :],
                rgb_float[-1, :, :],
                rgb_float[:, 0, :],
                rgb_float[:, -1, :],
            ],
            axis=0,
        )
        bg_rgb = np.median(border_pixels, axis=0)
        color_distance = np.sqrt(np.sum((rgb_float - bg_rgb) ** 2, axis=2))
        edge_x = ndi.sobel(gray, axis=1)
        edge_y = ndi.sobel(gray, axis=0)
        edge_strength = np.hypot(edge_x, edge_y)

        score = (
            0.55 * self._normalize(color_distance)
            + 0.30 * self._normalize(np.abs(enhanced_gray))
            + 0.15 * self._normalize(edge_strength)
        )

        mask = score > max(0.18, float(score.mean() + score.std() * 0.35))
        min_area = max(80, int(rgb.shape[0] * rgb.shape[1] * self.min_region_area_ratio))
        mask = self._clean_mask(mask, min_area)

        labels, count = ndi.label(mask)
        objects = ndi.find_objects(labels)
        image_area = rgb.shape[0] * rgb.shape[1]
        raw_candidates: list[RegionCandidate] = []

        for label_index in range(count):
            slices = objects[label_index]
            if slices is None:
                continue

            region_mask = labels[slices] == (label_index + 1)
            area = int(region_mask.sum())
            if area < min_area:
                continue

            y0, y1 = slices[0].start, slices[0].stop
            x0, x1 = slices[1].start, slices[1].stop
            height = y1 - y0
            width = x1 - x0
            if width <= 0 or height <= 0:
                continue

            if area / image_area > 0.24:
                continue

            aspect_ratio = max(width, height) / max(1, min(width, height))
            fill_ratio = area / float(width * height)
            centroid = ndi.center_of_mass(region_mask)
            split_count = self._estimate_piece_count(region_mask, area, aspect_ratio, fill_ratio)

            raw_candidates.append(
                RegionCandidate(
                    area=area,
                    bbox=(y0, x0, y1, x1),
                    aspect_ratio=float(aspect_ratio),
                    fill_ratio=float(fill_ratio),
                    centroid=(float(y0 + centroid[0]), float(x0 + centroid[1])),
                    split_count=split_count,
                    confidence=0.0,
                )
            )

        candidates = self._filter_same_scene_candidates(raw_candidates)
        candidates.sort(key=lambda item: (item.bbox[0], item.bbox[1]))
        return candidates

    def _clean_mask(self, mask: np.ndarray, min_area: int) -> np.ndarray:
        mask = ndi.binary_opening(mask, structure=np.ones((3, 3), dtype=bool))
        mask = ndi.binary_closing(mask, structure=np.ones((5, 5), dtype=bool))
        mask = ndi.binary_fill_holes(mask)

        labels, count = ndi.label(mask)
        if count == 0:
            return mask

        sizes = np.bincount(labels.ravel())
        keep = sizes >= min_area
        keep[0] = False
        cleaned = keep[labels]
        cleaned[[0, -1], :] = False
        cleaned[:, [0, -1]] = False
        return cleaned

    def _estimate_piece_count(
        self, region_mask: np.ndarray, area: int, aspect_ratio: float, fill_ratio: float
    ) -> int:
        distance = ndi.distance_transform_edt(region_mask)
        if float(distance.max()) <= 0:
            return 1

        footprint = np.ones((9, 9), dtype=bool)
        local_max = distance == ndi.maximum_filter(distance, footprint=footprint)
        seed_mask = local_max & region_mask & (distance > distance.max() * 0.38)
        seed_labels, seed_count = ndi.label(seed_mask)

        if seed_count >= 2:
            return min(4, seed_count)

        if fill_ratio < 0.38 and 1.6 <= aspect_ratio <= 4.2 and area > 600:
            return 2

        return 1

    def _filter_same_scene_candidates(
        self, candidates: list[RegionCandidate]
    ) -> list[RegionCandidate]:
        if not candidates:
            return []

        pill_like = [
            candidate
            for candidate in candidates
            if 1.0 <= candidate.aspect_ratio <= 4.8
            and 0.2 <= candidate.fill_ratio <= 0.96
            and candidate.area >= 80
        ]
        if not pill_like:
            return []

        median_area = float(np.median([candidate.area for candidate in pill_like]))
        median_aspect = float(np.median([candidate.aspect_ratio for candidate in pill_like]))
        filtered: list[RegionCandidate] = []
        for candidate in pill_like:
            area_ratio = candidate.area / max(1.0, median_area)
            aspect_gap = abs(candidate.aspect_ratio - median_aspect)
            if not (0.35 <= area_ratio <= 3.8):
                continue
            if aspect_gap > max(1.4, median_aspect * 0.9):
                continue

            confidence = 1.0
            confidence -= min(0.35, abs(area_ratio - 1.0) * 0.16)
            confidence -= min(0.25, aspect_gap * 0.12)
            confidence -= min(0.2, abs(candidate.fill_ratio - 0.62) * 0.45)
            filtered.append(
                RegionCandidate(
                    area=candidate.area,
                    bbox=candidate.bbox,
                    aspect_ratio=candidate.aspect_ratio,
                    fill_ratio=candidate.fill_ratio,
                    centroid=candidate.centroid,
                    split_count=candidate.split_count,
                    confidence=max(0.35, round(confidence, 3)),
                )
            )

        return filtered

    def _crop_region(
        self, image: Image.Image, bbox: tuple[int, int, int, int], padding_ratio: float
    ) -> Image.Image:
        min_row, min_col, max_row, max_col = bbox
        width = max_col - min_col
        height = max_row - min_row
        pad_x = int(width * padding_ratio)
        pad_y = int(height * padding_ratio)
        left = max(0, min_col - pad_x)
        top = max(0, min_row - pad_y)
        right = min(image.width, max_col + pad_x)
        bottom = min(image.height, max_row + pad_y)
        return image.crop((left, top, right, bottom))

    def _build_annotated_image(self, image: Image.Image, items: list[dict[str, Any]]) -> str:
        canvas = image.copy()
        draw = ImageDraw.Draw(canvas)
        font = ImageFont.load_default()

        for item in items:
            bbox = item["bbox"]
            left, top, right, bottom = (
                bbox["left"],
                bbox["top"],
                bbox["right"],
                bbox["bottom"],
            )
            color_hex = "#4d9cff"
            suffix = f" x{item['pieces']}" if item.get("pieces", 1) > 1 else ""
            label = f"{item['index']}. 候選顆粒{suffix}"

            draw.rectangle((left, top, right, bottom), outline=color_hex, width=4)
            text_box = draw.textbbox((left, top), label, font=font)
            text_width = text_box[2] - text_box[0]
            text_height = text_box[3] - text_box[1]
            label_top = max(0, top - text_height - 10)
            draw.rectangle(
                (left, label_top, left + text_width + 12, label_top + text_height + 8),
                fill=color_hex,
            )
            draw.text((left + 6, label_top + 4), label, fill="white", font=font)

        buffer = BytesIO()
        canvas.save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:image/png;base64,{encoded}"

    def _normalize(self, values: np.ndarray) -> np.ndarray:
        values = values.astype(np.float32)
        min_value = float(values.min())
        max_value = float(values.max())
        if max_value - min_value < 1e-6:
            return np.zeros_like(values, dtype=np.float32)
        return (values - min_value) / (max_value - min_value)
