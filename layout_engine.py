import fitz  # PyMuPDF >= 1.23.0
import json
import sys
import os
import argparse
from contextlib import contextmanager
from collections import defaultdict
from typing import List, Dict, Tuple, Optional, Any

# ----------------------------------------------------------------------
#                             UTILITIES
# ----------------------------------------------------------------------

@contextmanager
def suppress_output():
    """Suppress C-level output from PyMuPDF."""
    try:
        with open(os.devnull, "w") as devnull:
            old_stdout_fd = sys.stdout.fileno()
            old_stderr_fd = sys.stderr.fileno()
            saved_stdout_fd = os.dup(old_stdout_fd)
            saved_stderr_fd = os.dup(old_stderr_fd)
            try:
                sys.stdout.flush()
                sys.stderr.flush()
                os.dup2(devnull.fileno(), old_stdout_fd)
                os.dup2(devnull.fileno(), old_stderr_fd)
                yield
            finally:
                os.dup2(saved_stdout_fd, old_stdout_fd)
                os.dup2(saved_stderr_fd, old_stderr_fd)
                os.close(saved_stdout_fd)
                os.close(saved_stderr_fd)
    except Exception:
        yield

def bbox_to_rect(bbox: Tuple[float, float, float, float],
                 width: float, height: float) -> Dict[str, float]:
    """Convert absolute bbox to relative rect (l,t,w,h)."""
    x0, y0, x1, y1 = bbox
    l = round(x0 / width, 4) if width > 0 else 0
    t = round(y0 / height, 4) if height > 0 else 0
    w = round((x1 - x0) / width, 4) if width > 0 else 0
    h = round((y1 - y0) / height, 4) if height > 0 else 0
    return {"l": l, "t": t, "w": w, "h": h}

def classify_font(font_name: str) -> str:
    """Classify font family as serif or sans-serif."""
    f_lower = font_name.lower()
    serif_keywords = ["times", "serif", "roman", "cambria", "garamond",
                      "bookman", "palatino", "georgia"]
    if any(k in f_lower for k in serif_keywords):
        return "serif"
    return "sans-serif"

def bbox_overlap_ratio(bbox_a: Tuple[float, float, float, float],
                       bbox_b: Tuple[float, float, float, float]) -> float:
    """Overlap area of bbox_a inside bbox_b divided by area of bbox_a."""
    x0a, y0a, x1a, y1a = bbox_a
    x0b, y0b, x1b, y1b = bbox_b
    ix0 = max(x0a, x0b)
    iy0 = max(y0a, y0b)
    ix1 = min(x1a, x1b)
    iy1 = min(y1a, y1b)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    area_a = (x1a - x0a) * (y1a - y0a)
    if area_a == 0:
        return 0.0
    overlap_area = (ix1 - ix0) * (iy1 - iy0)
    return overlap_area / area_a

def merge_intervals(intervals: List[Tuple[float, float]],
                    min_gap: float) -> List[Tuple[float, float]]:
    """Merge intervals where the gap between them is <= min_gap."""
    if not intervals:
        return []
    intervals.sort()
    merged = []
    cur_start, cur_end = intervals[0]
    for s, e in intervals[1:]:
        if s - cur_end <= min_gap:
            cur_end = max(cur_end, e)
        else:
            merged.append((cur_start, cur_end))
            cur_start, cur_end = s, e
    merged.append((cur_start, cur_end))
    return merged

def merge_overlapping_bboxes(bboxes: List[Tuple[float, float, float, float]],
                             overlap_threshold: float = 0.2) -> List[Tuple[float, float, float, float]]:
    """Merge bboxes that overlap more than threshold (any direction)."""
    if not bboxes:
        return []
    bboxes = sorted(bboxes, key=lambda b: (b[1], b[0]))
    merged = [list(bboxes[0])]
    for cur in bboxes[1:]:
        absorbed = False
        for i in range(len(merged) - 1, -1, -1):
            last = merged[i]
            if (bbox_overlap_ratio(cur, tuple(last)) > overlap_threshold or
                bbox_overlap_ratio(tuple(last), cur) > overlap_threshold):
                last[0] = min(last[0], cur[0])
                last[1] = min(last[1], cur[1])
                last[2] = max(last[2], cur[2])
                last[3] = max(last[3], cur[3])
                absorbed = True
                break
        if not absorbed:
            merged.append(list(cur))
    return [tuple(m) for m in merged]

def is_potential_table(block: Dict, col_gap_threshold: float = 10.0) -> bool:
    """Heuristic: block looks like a table if it has at least two distinct left indents."""
    lines = block.get("lines", [])
    if len(lines) < 3:
        return False
    lefts = []
    for line in lines:
        spans = line.get("spans", [])
        if spans:
            lefts.append(spans[0]["bbox"][0])
    if not lefts:
        return False
    lefts = sorted(set(round(l, 1) for l in lefts))
    if len(lefts) < 2:
        return False
    # count clusters separated by gap
    num_clusters = 1
    for i in range(1, len(lefts)):
        if lefts[i] - lefts[i-1] > col_gap_threshold:
            num_clusters += 1
    return num_clusters >= 2

# ----------------------------------------------------------------------
#                         SPAN EXTRACTION
# ----------------------------------------------------------------------

def extract_spans_in_region(page: fitz.Page,
                            clip_rect: Optional[Tuple[float, float, float, float]] = None
                            ) -> List[Dict]:
    """Extract all text spans inside a rectangular region."""
    try:
        dict_data = page.get_text("dict", flags=fitz.TEXTFLAGS_DICT, clip=clip_rect)
        spans = []
        for block in dict_data.get("blocks", []):
            if block.get("type", 1) != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = span.get("text", "").strip()
                    if not text:
                        continue
                    spans.append({
                        "bbox": span["bbox"],
                        "text": text,
                        "size": span.get("size", 12),
                        "font": span.get("font", "")
                    })
        return spans
    except Exception:
        return []

# ----------------------------------------------------------------------
#                COLUMN DETECTION FOR NON‑TABLE TEXT
# ----------------------------------------------------------------------

def split_spans_vertically(spans: List[Dict],
                           min_gap: float = 6.0) -> List[List[Dict]]:
    """
    Group spans into visual columns based on X‑gap analysis.
    Returns a list of span groups, each group corresponds to one column.
    If only one column is found, returns a single group.
    """
    if not spans:
        return []
    # Build X intervals for each span
    intervals = [(s["bbox"][0], s["bbox"][2]) for s in spans]
    merged = merge_intervals(intervals, min_gap)
    if len(merged) <= 1:
        return [spans]
    # Assign each span to the interval that contains its midpoint
    groups = [[] for _ in merged]
    for span in spans:
        mid_x = (span["bbox"][0] + span["bbox"][2]) / 2
        best_idx = 0
        best_dist = float('inf')
        for i, (x0, x1) in enumerate(merged):
            if x0 - 2 <= mid_x <= x1 + 2:
                best_idx = i
                break
            # fallback: distance to interval edges
            dist = min(abs(mid_x - x0), abs(mid_x - x1))
            if dist < best_dist:
                best_dist = dist
                best_idx = i
        groups[best_idx].append(span)
    return [g for g in groups if g]

# ----------------------------------------------------------------------
#                     IMPROVED TABLE CELL CLUSTERING
#  (global column detection, then row detection per column, then alignment)
# ----------------------------------------------------------------------

def cluster_spans_into_cells(spans: List[Dict],
                             min_gap: float = 8.0) -> List[Dict]:
    """
    Convert raw spans inside a table region into cell dictionaries.
    Global column detection first, then row detection, then cell merging.
    This avoids the over‑separation problem of the original tab.py.
    """
    if not spans:
        return []

    # ----- 1. Detect columns (global X gaps) -----
    x_intervals = merge_intervals([(s["bbox"][0], s["bbox"][2]) for s in spans], min_gap)
    if len(x_intervals) <= 1:
        # Single column – fall back to simple row‑based grouping
        return _fallback_single_column_clustering(spans, min_gap)

    # Assign each span to a column (by midpoint)
    col_spans = [[] for _ in x_intervals]
    for s in spans:
        mid_x = (s["bbox"][0] + s["bbox"][2]) / 2
        # find nearest column interval
        best_idx = 0
        best_dist = float('inf')
        for i, (x0, x1) in enumerate(x_intervals):
            if x0 - 2 <= mid_x <= x1 + 2:
                best_idx = i
                break
            dist = min(abs(mid_x - x0), abs(mid_x - x1))
            if dist < best_dist:
                best_dist = dist
                best_idx = i
        col_spans[best_idx].append(s)

    # ----- 2. Detect rows in each column -----
    rows_per_col = []
    for col in col_spans:
        if not col:
            rows_per_col.append([])
            continue
        y_intervals = merge_intervals([(s["bbox"][1], s["bbox"][3]) for s in col], min_gap)
        rows_per_col.append(y_intervals)

    # ----- 3. Align rows across columns -----
    # Collect all row boundaries (top and bottom) from every column
    all_breaks = set()
    for col_rows in rows_per_col:
        for y0, y1 in col_rows:
            all_breaks.add(y0)
            all_breaks.add(y1)
    if not all_breaks:
        return []
    sorted_breaks = sorted(all_breaks)
    # Build row intervals from these breaks (use midpoints as separators)
    row_intervals = []
    for i in range(len(sorted_breaks) - 1):
        if sorted_breaks[i+1] - sorted_breaks[i] > min_gap:
            # gap indicates row separation – define a row interval
            row_intervals.append((sorted_breaks[i], sorted_breaks[i+1]))
    if not row_intervals:
        # No clear row gaps: treat whole region as one row
        row_intervals = [(min(s["bbox"][1] for s in spans),
                          max(s["bbox"][3] for s in spans))]

    # ----- 4. Assign spans to (row, column) cells -----
    cells_dict = defaultdict(list)  # key = (row_idx, col_idx)
    for col_idx, col in enumerate(col_spans):
        for s in col:
            y_mid = (s["bbox"][1] + s["bbox"][3]) / 2
            row_idx = None
            for i, (y0, y1) in enumerate(row_intervals):
                if y0 <= y_mid <= y1:
                    row_idx = i
                    break
            if row_idx is None:
                # assign to nearest row
                row_idx = min(range(len(row_intervals)),
                              key=lambda i: min(abs(y_mid - row_intervals[i][0]),
                                                abs(y_mid - row_intervals[i][1])))
            cells_dict[(row_idx, col_idx)].append(s)

    # ----- 5. Build cell objects -----
    cells = []
    for (r, c), cell_spans in cells_dict.items():
        if not cell_spans:
            continue
        # merge bbox
        x0 = min(s["bbox"][0] for s in cell_spans)
        y0 = min(s["bbox"][1] for s in cell_spans)
        x1 = max(s["bbox"][2] for s in cell_spans)
        y1 = max(s["bbox"][3] for s in cell_spans)
        # merge text, preserving line breaks
        lines_dict = defaultdict(list)
        for s in cell_spans:
            y_center = (s["bbox"][1] + s["bbox"][3]) / 2
            line_key = round(y_center, 1)  # group by vertical position
            lines_dict[line_key].append(s)
        text_parts = []
        for y_key in sorted(lines_dict.keys()):
            line_spans = sorted(lines_dict[y_key], key=lambda s: s["bbox"][0])
            line_text = " ".join(s["text"] for s in line_spans).strip()
            if line_text:
                text_parts.append(line_text)
        text = "\n".join(text_parts).strip()
        if not text:
            continue
        # collect font info
        font_sizes = [round(s["size"], 2) for s in cell_spans]
        font_families = {classify_font(s["font"]) for s in cell_spans}
        dominant_font = next(iter(font_families)) if font_families else "sans-serif"
        avg_font_size = sum(font_sizes) / len(font_sizes) if font_sizes else 12.0
        cells.append({
            "bbox": (x0, y0, x1, y1),
            "text": text,
            "font_sizes": font_sizes,
            "dominant_font": dominant_font,
            "avg_font_size": avg_font_size
        })
    # sort cells top‑to‑bottom, left‑to‑right
    cells.sort(key=lambda c: (c["bbox"][1], c["bbox"][0]))
    return cells

def _fallback_single_column_clustering(spans: List[Dict],
                                       min_gap: float) -> List[Dict]:
    """Simpler row‑based grouping when only one column is detected."""
    if not spans:
        return []
    # group by vertical proximity
    y_intervals = merge_intervals([(s["bbox"][1], s["bbox"][3]) for s in spans], min_gap)
    row_groups = [[] for _ in y_intervals]
    for s in spans:
        y_mid = (s["bbox"][1] + s["bbox"][3]) / 2
        for i, (y0, y1) in enumerate(y_intervals):
            if y0 <= y_mid <= y1:
                row_groups[i].append(s)
                break
    cells = []
    for row in row_groups:
        if not row:
            continue
        x0 = min(s["bbox"][0] for s in row)
        y0 = min(s["bbox"][1] for s in row)
        x1 = max(s["bbox"][2] for s in row)
        y1 = max(s["bbox"][3] for s in row)
        # join text in reading order
        row.sort(key=lambda s: (s["bbox"][1], s["bbox"][0]))
        text = " ".join(s["text"] for s in row)
        font_sizes = [round(s["size"], 2) for s in row]
        font_families = {classify_font(s["font"]) for s in row}
        dominant_font = next(iter(font_families)) if font_families else "sans-serif"
        avg_font_size = sum(font_sizes) / len(font_sizes) if font_sizes else 12.0
        cells.append({
            "bbox": (x0, y0, x1, y1),
            "text": text,
            "font_sizes": font_sizes,
            "dominant_font": dominant_font,
            "avg_font_size": avg_font_size
        })
    return cells

# ----------------------------------------------------------------------
#              BUILD A FINAL BLOCK FROM A GROUP OF SPANS
# ----------------------------------------------------------------------

def cluster_spans_to_block(spans: List[Dict],
                           width: float, height: float,
                           block_id: str,
                           is_table_cell: bool = False) -> Optional[Dict]:
    """
    Convert a list of spans (already grouped as a logical block)
    into the final output dictionary.
    """
    if not spans:
        return None
    # overall bbox
    x0 = min(s["bbox"][0] for s in spans)
    y0 = min(s["bbox"][1] for s in spans)
    x1 = max(s["bbox"][2] for s in spans)
    y1 = max(s["bbox"][3] for s in spans)

    # sort spans in reading order (approximate)
    spans.sort(key=lambda s: (round(s["bbox"][1], 1), s["bbox"][0]))

    # group into lines based on vertical overlap
    lines = defaultdict(list)
    for s in spans:
        mid_y = (s["bbox"][1] + s["bbox"][3]) / 2
        line_key = round(mid_y / 5) * 5  # bin in 5pt steps
        lines[line_key].append(s)

    text_parts = []
    font_sizes = []
    font_families = set()
    for y_key in sorted(lines.keys()):
        line_spans = sorted(lines[y_key], key=lambda s: s["bbox"][0])
        line_text = " ".join(s["text"] for s in line_spans)
        text_parts.append(line_text)
        for s in line_spans:
            font_sizes.append(s["size"])
            font_families.add(classify_font(s["font"]))

    full_text = "\n".join(text_parts).strip()
    if not full_text:
        return None

    dominant_font = next(iter(font_families)) if font_families else "sans-serif"
    avg_size = sum(font_sizes) / len(font_sizes) if font_sizes else 12.0

    return {
        "id": block_id,
        "text": full_text,
        "rect": bbox_to_rect((x0, y0, x1, y1), width, height),
        "fontFamily": dominant_font,
        "fontSize": round(avg_size, 2),
        "originalFontSizes": [round(x, 2) for x in font_sizes],
        # internal fields for overlap resolution
        "_bbox": (x0, y0, x1, y1),
        "_area": (x1 - x0) * (y1 - y0),
        "_is_table_cell": is_table_cell
    }

# ----------------------------------------------------------------------
#                         MAIN LAYOUT ENGINE
# ----------------------------------------------------------------------

def get_layout_data(pdf_path: str) -> Dict[str, List[Dict]]:
    """Extract layout blocks from every page of the PDF."""
    doc = fitz.open(pdf_path)
    output = {}

    try:
        for page_num in range(len(doc)):
            page = doc[page_num]
            page_key = str(page_num + 1)
            width = page.rect.width
            height = page.rect.height

            # ----------------------------------------------------------
            # 1. Detect explicit tables using PyMuPDF (multiple strategies)
            # ----------------------------------------------------------
            table_bboxes = []
            for strategy in ["lines_strict", "lines", "text"]:
                try:
                    tables = page.find_tables(strategy=strategy, min_cells=2)
                    for tbl in tables:
                        if tbl.bbox:
                            table_bboxes.append(tbl.bbox)
                except Exception:
                    continue
            table_bboxes = merge_overlapping_bboxes(table_bboxes, overlap_threshold=0.2)

            # ----------------------------------------------------------
            # 2. Process each table region with improved cell clustering
            # ----------------------------------------------------------
            table_cell_blocks = []
            cell_counter = 0
            for tbl_bbox in table_bboxes:
                spans = extract_spans_in_region(page, clip_rect=tbl_bbox)
                if not spans:
                    continue
                cells = cluster_spans_into_cells(spans, min_gap=8.0)
                for cell in cells:
                    # get spans strictly inside the cell bbox (refine)
                    cell_spans = [s for s in spans if
                                  s["bbox"][0] >= cell["bbox"][0] - 2 and
                                  s["bbox"][2] <= cell["bbox"][2] + 2 and
                                  s["bbox"][1] >= cell["bbox"][1] - 2 and
                                  s["bbox"][3] <= cell["bbox"][3] + 2]
                    if not cell_spans:
                        continue
                    blk = cluster_spans_to_block(
                        cell_spans, width, height,
                        f"p{page_key}-t{cell_counter}",
                        is_table_cell=True
                    )
                    if blk:
                        table_cell_blocks.append(blk)
                        cell_counter += 1

            # ----------------------------------------------------------
            # 3. Process all remaining raw blocks (non‑table areas)
            # ----------------------------------------------------------
            try:
                raw_blocks = page.get_text("dict", flags=fitz.TEXTFLAGS_DICT)["blocks"]
            except Exception:
                raw_blocks = []

            non_table_blocks = []
            block_counter = 0

            for raw_blk in raw_blocks:
                if raw_blk.get("type", 1) != 0:   # skip images
                    continue
                bbox = raw_blk.get("bbox")
                if not bbox or len(bbox) != 4:
                    continue
                if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
                    continue

                # skip if this block overlaps heavily with any detected table
                if any(bbox_overlap_ratio(bbox, tbl_bbox) > 0.4 for tbl_bbox in table_bboxes):
                    continue

                # collect all spans in this raw block
                spans = []
                for line in raw_blk.get("lines", []):
                    for span in line.get("spans", []):
                        text = span.get("text", "").strip()
                        if text:
                            spans.append({
                                "bbox": span["bbox"],
                                "text": text,
                                "size": span.get("size", 12),
                                "font": span.get("font", "")
                            })
                if not spans:
                    continue

                # Check if this block looks like an unnoticed table
                if is_potential_table(raw_blk):
                    # treat as table → cluster into cells
                    cells = cluster_spans_into_cells(spans, min_gap=8.0)
                    for cell in cells:
                        cell_spans = [s for s in spans if
                                      s["bbox"][0] >= cell["bbox"][0] - 2 and
                                      s["bbox"][2] <= cell["bbox"][2] + 2 and
                                      s["bbox"][1] >= cell["bbox"][1] - 2 and
                                      s["bbox"][3] <= cell["bbox"][3] + 2]
                        if not cell_spans:
                            continue
                        blk = cluster_spans_to_block(
                            cell_spans, width, height,
                            f"p{page_key}-u{block_counter}",
                            is_table_cell=True
                        )
                        if blk:
                            non_table_blocks.append(blk)
                            block_counter += 1
                else:
                    # normal text – split into columns first, then make blocks
                    col_groups = split_spans_vertically(spans, min_gap=6.0)
                    for col_idx, group in enumerate(col_groups):
                        if not group:
                            continue
                        blk = cluster_spans_to_block(
                            group, width, height,
                            f"p{page_key}-c{block_counter}",
                            is_table_cell=False
                        )
                        if blk:
                            non_table_blocks.append(blk)
                            block_counter += 1

            # ----------------------------------------------------------
            # 4. Global overlap resolution (gem‑style priority)
            # ----------------------------------------------------------
            all_candidates = table_cell_blocks + non_table_blocks
            # Priority: table cells first, then smaller blocks
            all_candidates.sort(key=lambda x: (not x["_is_table_cell"], x["_area"]))

            kept_blocks = []
            for cand in all_candidates:
                redundant = False
                cand_bbox = cand["_bbox"]
                cand_area = cand["_area"]
                for kept in kept_blocks:
                    kept_bbox = kept["_bbox"]
                    kept_area = kept["_area"]

                    # compute intersection
                    ix0 = max(cand_bbox[0], kept_bbox[0])
                    iy0 = max(cand_bbox[1], kept_bbox[1])
                    ix1 = min(cand_bbox[2], kept_bbox[2])
                    iy1 = min(cand_bbox[3], kept_bbox[3])

                    if ix1 > ix0 and iy1 > iy0:
                        inter = (ix1 - ix0) * (iy1 - iy0)

                        # case 1: candidate is mostly inside a kept table cell → discard
                        if kept["_is_table_cell"] and (inter / cand_area > 0.3):
                            redundant = True
                            break

                        # case 2: candidate (larger) swallows a smaller kept block
                        if not cand["_is_table_cell"] and (inter / kept_area > 0.8):
                            redundant = True
                            break

                if not redundant:
                    kept_blocks.append(cand)

            # ----------------------------------------------------------
            # 5. Final cleanup: remove internal keys, sort, reassign IDs
            # ----------------------------------------------------------
            kept_blocks.sort(key=lambda b: (b["rect"]["t"], b["rect"]["l"]))
            final_blocks = []
            for i, blk in enumerate(kept_blocks):
                blk.pop("_bbox", None)
                blk.pop("_area", None)
                blk.pop("_is_table_cell", None)
                blk["id"] = f"p{page_key}-b{i}"
                final_blocks.append(blk)

            output[page_key] = final_blocks

    finally:
        doc.close()

    return output

# ----------------------------------------------------------------------
#                              CLI
# ----------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract layout blocks from PDF (tables & text).")
    parser.add_argument("pdf_path", help="Path to the PDF file")
    args = parser.parse_args()

    result = {}
    try:
        with suppress_output():
            result = get_layout_data(args.pdf_path)
    except Exception as e:
        result = {"error": str(e)}

    print(json.dumps(result))