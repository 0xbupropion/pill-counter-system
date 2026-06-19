from __future__ import annotations

import base64
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
import re
from typing import Any

import numpy as np
import pandas as pd
from PIL import Image, ImageDraw, ImageFont, ImageOps
from scipy import ndimage as ndi
from skimage import color, exposure, feature, filters, measure, morphology, segmentation, util


@dataclass
class RegionCandidate:
    area: int
    bbox: tuple[int, int, int, int]
    aspect_ratio: float
    solidity: float
    extent: float
    eccentricity: float
    area_ratio: float
    centroid: tuple[float, float]


class OptionalTorchClassifier:
    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.ready = False
        self.load_attempted = False
        self.status = "模型尚未初始化。"
        self.device = "cpu"
        self.model = None
        self.transforms = None
        self.class_names: dict[int, str] = {}
        self._torch = None

        self.weights_path = (
            project_root
            / "Final_Poster_Project_Pill_Recgonizer"
            / "weights"
            / "weight_adam_30epoch_custonDatasetNorm"
            / "best_weights.pth"
        )
        self.class_name_csv = (
            project_root / "Final_Poster_Project_Pill_Recgonizer" / "class_name.csv"
        )

    def ensure_loaded(self) -> bool:
        if self.ready:
            return True
        if self.load_attempted:
            return False

        self.load_attempted = True

        try:
            import torch
            import torchvision.models as models
            import torchvision.transforms as transforms
        except Exception as error:  # pragma: no cover - depends on local env
            self.status = (
                "正式分類模型未啟用，因為缺少 torch / torchvision。"
                f" 目前改用強化版影像分割與外型推估。({error})"
            )
            return False

        if not self.weights_path.exists() or not self.class_name_csv.exists():
            self.status = "找不到既有分類模型權重或 class_name.csv。"
            return False

        df = pd.read_csv(self.class_name_csv)
        num_classes = int(df["Name"].nunique())
        self.class_names = {
            int(class_id): str(name)
            for class_id, name in zip(df["Class_ID"], df["Name"])
        }

        model = models.resnext50_32x4d(weights=None)
        model.fc = torch.nn.Linear(2048, num_classes)
        state_dict = torch.load(self.weights_path, map_location="cpu")
        model.load_state_dict(state_dict)
        model.eval()

        self._torch = torch
        self.model = model
        self.transforms = transforms.Compose(
            [
                transforms.Resize((224, 224)),
                transforms.ToTensor(),
                transforms.Normalize(
                    mean=[0.5783, 0.5265, 0.4727],
                    std=[0.1603, 0.1554, 0.1512],
                ),
            ]
        )
        self.ready = True
        self.status = "既有 ResNeXt 分類模型已載入，可辨識單顆藥丸品項。"
        return True

    def classify(self, crop: Image.Image) -> dict[str, Any]:
        if not self.ensure_loaded():
            return {
                "model_ready": False,
                "pill_name": None,
                "confidence": None,
                "status": self.status,
            }

        image_tensor = self.transforms(crop.convert("RGB")).unsqueeze(0)
        with self._torch.no_grad():
            output = self.model(image_tensor)
            probs = self._torch.nn.functional.softmax(output, dim=1)[0]
            confidence, predicted = probs.max(0)

        class_id = int(predicted.item())
        return {
            "model_ready": True,
            "pill_name": self.class_names.get(class_id, f"Class {class_id}"),
            "confidence": float(confidence.item()),
            "status": self.status,
        }


class PillAnalysisEngine:
    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.classifier = OptionalTorchClassifier(project_root)
        self.min_region_area_ratio = 0.0002
        self.max_input_side = 1600

    def health(self) -> dict[str, Any]:
        model_ready = self.classifier.ensure_loaded()
        return {
            "ok": True,
            "modelReady": model_ready,
            "modelStatus": self.classifier.status,
            "pipeline": [
                "border-aware foreground separation",
                "contrast enhancement",
                "watershed overlap split",
                "optional ResNeXt pill classification",
            ],
        }

    def analyze_image_bytes(self, raw: bytes, filename: str = "uploaded-image") -> dict[str, Any]:
        image = Image.open(BytesIO(raw))
        image = ImageOps.exif_transpose(image).convert("RGB")
        image = self._resize_image(image)
        rgb = np.asarray(image, dtype=np.uint8)

        candidates, labels = self._segment_candidates(rgb)
        items = []
        counts = {"tablet": 0, "capsule": 0, "needle": 0}

        for index, candidate in enumerate(candidates, start=1):
            crop = self._crop_region(image, candidate.bbox, padding_ratio=0.16)
            fallback_form = self._shape_based_form(candidate)

            model_result = self.classifier.classify(crop)
            model_name = model_result.get("pill_name")
            form = self._infer_form_from_name(model_name) or fallback_form
            if candidate.aspect_ratio >= 4.6 and candidate.solidity <= 0.42:
                form = "needle"

            counts[form] += 1
            items.append(
                {
                    "index": index,
                    "bbox": {
                        "left": candidate.bbox[1],
                        "top": candidate.bbox[0],
                        "right": candidate.bbox[3],
                        "bottom": candidate.bbox[2],
                    },
                    "type": form,
                    "pillName": model_name,
                    "confidence": model_result.get("confidence"),
                    "shapeSummary": {
                        "aspectRatio": round(candidate.aspect_ratio, 2),
                        "solidity": round(candidate.solidity, 2),
                        "extent": round(candidate.extent, 2),
                    },
                    "status": model_result.get("status"),
                }
            )

        annotated = self._build_annotated_image(image, items)
        total_count = sum(counts.values())
        return {
            "ok": True,
            "sourceFile": filename,
            "counts": counts,
            "totalCount": total_count,
            "items": items,
            "annotatedImage": annotated,
            "modelReady": self.classifier.ready,
            "modelStatus": self.classifier.status,
            "notes": [
                "背景顏色接近時，這版會同時參考邊界背景色、局部對比與邊緣強度。",
                "藥丸重疊時，這版會用距離轉換 + watershed 盡量拆開相黏物件。",
            ],
            "debug": {
                "regions": len(items),
                "imageWidth": image.width,
                "imageHeight": image.height,
                "watershedLabels": int(labels.max()) if labels.size else 0,
            },
        }

    def _resize_image(self, image: Image.Image) -> Image.Image:
        longest_side = max(image.size)
        if longest_side <= self.max_input_side:
            return image

        scale = self.max_input_side / float(longest_side)
        next_size = (max(1, int(image.width * scale)), max(1, int(image.height * scale)))
        return image.resize(next_size, Image.Resampling.LANCZOS)

    def _segment_candidates(
        self, rgb: np.ndarray
    ) -> tuple[list[RegionCandidate], np.ndarray]:
        rgb_float = util.img_as_float(rgb)
        lab = color.rgb2lab(rgb_float)
        gray = color.rgb2gray(rgb_float)
        enhanced_gray = exposure.equalize_adapthist(gray, clip_limit=0.03)

        border_pixels = np.concatenate(
            [
                lab[0, :, :],
                lab[-1, :, :],
                lab[:, 0, :],
                lab[:, -1, :],
            ],
            axis=0,
        )
        bg_lab = np.median(border_pixels, axis=0)
        color_distance = np.linalg.norm(lab - bg_lab, axis=2)
        local_contrast = np.abs(enhanced_gray - filters.gaussian(enhanced_gray, sigma=4))
        edges = filters.sobel(enhanced_gray)

        color_score = self._normalize_map(color_distance)
        contrast_score = self._normalize_map(local_contrast)
        edge_score = self._normalize_map(edges)
        score = 0.58 * color_score + 0.27 * contrast_score + 0.15 * edge_score

        global_threshold = filters.threshold_otsu(score)
        block_size = 51 if min(score.shape) >= 51 else 31
        if block_size % 2 == 0:
            block_size += 1
        adaptive_threshold = filters.threshold_local(score, block_size=block_size, offset=-0.02)
        mask = (score > max(global_threshold * 0.9, 0.08)) & (
            score > adaptive_threshold - 0.004
        )

        min_area = max(96, int(rgb.shape[0] * rgb.shape[1] * self.min_region_area_ratio))
        mask = morphology.remove_small_objects(mask, min_size=min_area)
        mask = morphology.binary_closing(mask, morphology.disk(3))
        mask = morphology.binary_closing(mask, morphology.rectangle(3, 9))
        mask = morphology.binary_closing(mask, morphology.rectangle(9, 3))
        mask = morphology.binary_opening(mask, morphology.disk(2))
        mask = ndi.binary_fill_holes(mask)
        mask = segmentation.clear_border(mask, buffer_size=2)
        mask = morphology.remove_small_holes(mask, area_threshold=min_area * 4)

        distance = ndi.distance_transform_edt(mask)
        peak_distance = max(12, int(np.sqrt(min_area) * 1.4))
        peaks = feature.peak_local_max(
            distance,
            labels=mask,
            min_distance=peak_distance,
            threshold_abs=distance.max() * 0.24 if distance.max() > 0 else 0,
            exclude_border=False,
        )

        markers = np.zeros_like(distance, dtype=np.int32)
        if len(peaks):
            for marker_index, (row, col) in enumerate(peaks, start=1):
                markers[row, col] = marker_index
        else:
            markers, _ = ndi.label(mask)

        labels = segmentation.watershed(-distance, markers, mask=mask)
        regions = measure.regionprops(labels)
        candidates: list[RegionCandidate] = []
        image_area = rgb.shape[0] * rgb.shape[1]

        for region in regions:
            if region.area < min_area:
                continue

            min_row, min_col, max_row, max_col = region.bbox
            height = max_row - min_row
            width = max_col - min_col
            short_edge = max(1, min(height, width))
            long_edge = max(height, width)
            aspect_ratio = long_edge / short_edge
            area_ratio = region.area / image_area

            if area_ratio > 0.22:
                continue

            candidates.append(
                RegionCandidate(
                    area=int(region.area),
                    bbox=(min_row, min_col, max_row, max_col),
                    aspect_ratio=float(aspect_ratio),
                    solidity=float(region.solidity or 0.0),
                    extent=float(region.extent or 0.0),
                    eccentricity=float(region.eccentricity or 0.0),
                    area_ratio=float(area_ratio),
                    centroid=(float(region.centroid[0]), float(region.centroid[1])),
                )
            )

        candidates.sort(key=lambda item: (item.bbox[0], item.bbox[1]))
        candidates = self._merge_fragmented_candidates(candidates, image_area)
        edge_candidates = self._edge_based_candidates(enhanced_gray, min_area, image_area)
        for edge_candidate in edge_candidates:
            overlaps_existing = any(
                self._bbox_intersection_ratio(edge_candidate.bbox, current.bbox) >= 0.28
                for current in candidates
            )
            if not overlaps_existing:
                candidates.append(edge_candidate)

        candidates.sort(key=lambda item: (item.bbox[0], item.bbox[1]))
        return candidates, labels

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

    def _shape_based_form(self, candidate: RegionCandidate) -> str:
        if candidate.aspect_ratio >= 4.4 and candidate.solidity <= 0.45:
            return "needle"
        if candidate.aspect_ratio >= 1.65 or candidate.eccentricity >= 0.9:
            return "capsule"
        return "tablet"

    def _edge_based_candidates(
        self, enhanced_gray: np.ndarray, min_area: int, image_area: int
    ) -> list[RegionCandidate]:
        edge_mask = feature.canny(
            enhanced_gray,
            sigma=2,
            low_threshold=0.05,
            high_threshold=0.16,
        )
        edge_mask = morphology.binary_dilation(edge_mask, morphology.disk(2))
        edge_mask = ndi.binary_fill_holes(edge_mask)
        edge_mask = morphology.remove_small_objects(edge_mask, min_size=min_area * 2)
        edge_mask = segmentation.clear_border(edge_mask, buffer_size=1)

        proposals: list[RegionCandidate] = []
        for region in measure.regionprops(measure.label(edge_mask)):
            if region.area < min_area * 2:
                continue

            area_ratio = region.area / image_area
            if area_ratio > 0.16:
                continue

            min_row, min_col, max_row, max_col = region.bbox
            height = max_row - min_row
            width = max_col - min_col
            short_edge = max(1, min(height, width))
            long_edge = max(height, width)
            proposals.append(
                RegionCandidate(
                    area=int(region.area),
                    bbox=(min_row, min_col, max_row, max_col),
                    aspect_ratio=float(long_edge / short_edge),
                    solidity=float(region.solidity or 0.0),
                    extent=float(region.extent or 0.0),
                    eccentricity=float(region.eccentricity or 0.0),
                    area_ratio=float(area_ratio),
                    centroid=(float(region.centroid[0]), float(region.centroid[1])),
                )
            )

        return proposals

    def _merge_fragmented_candidates(
        self, candidates: list[RegionCandidate], image_area: int
    ) -> list[RegionCandidate]:
        if len(candidates) <= 1:
            return candidates

        solid_candidates: list[RegionCandidate] = []
        fragments: list[RegionCandidate] = []
        for candidate in candidates:
            height = candidate.bbox[2] - candidate.bbox[0]
            width = candidate.bbox[3] - candidate.bbox[1]
            short_edge = max(1, min(height, width))
            is_fragment = (
                candidate.aspect_ratio >= 3.8
                and candidate.extent >= 0.88
                and candidate.solidity >= 0.9
                and short_edge <= 28
            )
            if is_fragment:
                fragments.append(candidate)
            else:
                solid_candidates.append(candidate)

        merged_solids = solid_candidates[:]
        leftover_fragments: list[RegionCandidate] = []

        for fragment in fragments:
            anchor_index = self._find_fragment_anchor(fragment, merged_solids)
            if anchor_index is None:
                leftover_fragments.append(fragment)
                continue

            merged_solids[anchor_index] = self._merge_two_candidates(
                merged_solids[anchor_index], fragment, image_area
            )

        if leftover_fragments:
            grouped = self._group_nearby_fragments(leftover_fragments, image_area)
            merged_solids.extend(grouped)

        merged_solids.sort(key=lambda item: (item.bbox[0], item.bbox[1]))
        return merged_solids

    def _find_fragment_anchor(
        self, fragment: RegionCandidate, anchors: list[RegionCandidate]
    ) -> int | None:
        best_index = None
        best_gap = None
        for index, anchor in enumerate(anchors):
            row_overlap = self._overlap_length(
                fragment.bbox[0], fragment.bbox[2], anchor.bbox[0], anchor.bbox[2]
            )
            col_overlap = self._overlap_length(
                fragment.bbox[1], fragment.bbox[3], anchor.bbox[1], anchor.bbox[3]
            )
            fragment_height = fragment.bbox[2] - fragment.bbox[0]
            fragment_width = fragment.bbox[3] - fragment.bbox[1]
            anchor_height = anchor.bbox[2] - anchor.bbox[0]
            anchor_width = anchor.bbox[3] - anchor.bbox[1]

            same_row = row_overlap / max(1, min(fragment_height, anchor_height)) >= 0.82
            same_col = col_overlap / max(1, min(fragment_width, anchor_width)) >= 0.82
            if not same_row and not same_col:
                continue

            gap = self._bbox_gap(fragment.bbox, anchor.bbox)
            if gap > 24:
                continue

            if best_gap is None or gap < best_gap:
                best_gap = gap
                best_index = index

        return best_index

    def _group_nearby_fragments(
        self, fragments: list[RegionCandidate], image_area: int
    ) -> list[RegionCandidate]:
        groups: list[list[RegionCandidate]] = []
        for fragment in fragments:
            placed = False
            for group in groups:
                if any(self._bbox_gap(fragment.bbox, member.bbox) <= 18 for member in group):
                    group.append(fragment)
                    placed = True
                    break
            if not placed:
                groups.append([fragment])

        merged: list[RegionCandidate] = []
        for group in groups:
            combined = group[0]
            for fragment in group[1:]:
                combined = self._merge_two_candidates(combined, fragment, image_area)
            merged.append(combined)
        return merged

    def _merge_two_candidates(
        self, first: RegionCandidate, second: RegionCandidate, image_area: int
    ) -> RegionCandidate:
        min_row = min(first.bbox[0], second.bbox[0])
        min_col = min(first.bbox[1], second.bbox[1])
        max_row = max(first.bbox[2], second.bbox[2])
        max_col = max(first.bbox[3], second.bbox[3])
        width = max_col - min_col
        height = max_row - min_row
        short_edge = max(1, min(width, height))
        long_edge = max(width, height)
        area = first.area + second.area
        centroid = (
            ((first.centroid[0] * first.area) + (second.centroid[0] * second.area)) / area,
            ((first.centroid[1] * first.area) + (second.centroid[1] * second.area)) / area,
        )
        return RegionCandidate(
            area=area,
            bbox=(min_row, min_col, max_row, max_col),
            aspect_ratio=float(long_edge / short_edge),
            solidity=min(first.solidity, second.solidity),
            extent=min(first.extent, second.extent),
            eccentricity=max(first.eccentricity, second.eccentricity),
            area_ratio=float(area / image_area),
            centroid=centroid,
        )

    def _bbox_gap(
        self, first: tuple[int, int, int, int], second: tuple[int, int, int, int]
    ) -> int:
        vertical_gap = max(0, max(first[0], second[0]) - min(first[2], second[2]))
        horizontal_gap = max(0, max(first[1], second[1]) - min(first[3], second[3]))
        return max(vertical_gap, horizontal_gap)

    def _overlap_length(self, start_a: int, end_a: int, start_b: int, end_b: int) -> int:
        return max(0, min(end_a, end_b) - max(start_a, start_b))

    def _bbox_intersection_ratio(
        self, first: tuple[int, int, int, int], second: tuple[int, int, int, int]
    ) -> float:
        inter_height = self._overlap_length(first[0], first[2], second[0], second[2])
        inter_width = self._overlap_length(first[1], first[3], second[1], second[3])
        if inter_height == 0 or inter_width == 0:
            return 0.0

        intersection = inter_height * inter_width
        first_area = max(1, (first[2] - first[0]) * (first[3] - first[1]))
        second_area = max(1, (second[2] - second[0]) * (second[3] - second[1]))
        return intersection / min(first_area, second_area)

    def _infer_form_from_name(self, name: str | None) -> str | None:
        if not name:
            return None

        upper_name = name.upper()
        if re.search(r"\b(CAP|CAPSULE|CAPULES)\b", upper_name):
            return "capsule"
        if re.search(r"\b(TAB|TABLET|TABLETS|ODT)\b", upper_name):
            return "tablet"
        return None

    def _build_annotated_image(self, image: Image.Image, items: list[dict[str, Any]]) -> str:
        canvas = image.copy()
        draw = ImageDraw.Draw(canvas)
        font = ImageFont.load_default()
        colors = {"tablet": "#eba638", "capsule": "#63c949", "needle": "#ef6f74"}

        for item in items:
            bbox = item["bbox"]
            left, top, right, bottom = (
                bbox["left"],
                bbox["top"],
                bbox["right"],
                bbox["bottom"],
            )
            color_hex = colors[item["type"]]
            label = item["type"]
            if item["pillName"]:
                label = f'{item["index"]}. {item["pillName"]}'
            else:
                label = f'{item["index"]}. {item["type"]}'

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

    def _normalize_map(self, values: np.ndarray) -> np.ndarray:
        values = values.astype(np.float32)
        min_value = float(values.min())
        max_value = float(values.max())
        if max_value - min_value < 1e-6:
            return np.zeros_like(values, dtype=np.float32)
        return (values - min_value) / (max_value - min_value)
