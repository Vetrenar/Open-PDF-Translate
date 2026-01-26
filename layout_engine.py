import fitz  # PyMuPDF
import json
import sys
import os
import argparse
from contextlib import contextmanager

# Context manager to suppress C-level stdout and stderr
@contextmanager
def suppress_output():
    """Suppress C-level output from PyMuPDF to keep JSON output clean."""
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
        # If suppression fails, just continue without it
        yield


def get_layout_data(pdf_path):
    """Extract layout data from PDF including text blocks."""
    doc = None
    
    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        raise Exception(f"Failed to open PDF: {str(e)}")
    
    output_data = {}
    
    try:
        for page_num, page in enumerate(doc):
            page_key = str(page_num + 1)
            width = page.rect.width
            height = page.rect.height
            
            # Get text blocks - use basic 'dict' mode for compatibility
            try:
                blocks = page.get_text("dict")["blocks"]
            except Exception:
                output_data[page_key] = []
                continue
            
            page_items = []

            for b_idx, b in enumerate(blocks):
                try:
                    if b.get("type", 1) != 0:  # Skip images
                        continue

                    bbox = b.get('bbox')
                    if not bbox or len(bbox) != 4:
                        continue
                    
                    x0, y0, x1, y1 = bbox
                    
                    # Skip invalid boxes
                    if x1 <= x0 or y1 <= y0:
                        continue
                    
                    l = round(x0 / width, 4) if width > 0 else 0
                    t = round(y0 / height, 4) if height > 0 else 0
                    w = round((x1 - x0) / width, 4) if width > 0 else 0
                    h = round((y1 - y0) / height, 4) if height > 0 else 0

                    text_content = ""
                    font_sizes = []
                    font_families = set()

                    for line in b.get("lines", []):
                        line_text = ""
                        for span in line.get("spans", []):
                            span_text = span.get("text", "")
                            line_text += span_text
                            
                            font_size = span.get("size", 12)
                            if font_size > 0:
                                font_sizes.append(round(font_size, 2))
                            
                            f_name = span.get("font", "").lower()
                            
                            if any(x in f_name for x in ["times", "serif", "roman", "cambria", "garamond"]):
                                font_families.add("serif")
                            elif any(x in f_name for x in ["arial", "sans", "helvetica", "roboto", "calibri"]):
                                font_families.add("sans-serif")
                            else:
                                font_families.add("sans-serif")
                        
                        text_content += line_text + " "

                    text_content = text_content.strip()
                    if not text_content:
                        continue

                    avg_font_size = sum(font_sizes) / len(font_sizes) if font_sizes else 12
                    dominant_font = list(font_families)[0] if font_families else "sans-serif"

                    page_items.append({
                        "id": f"p{page_key}-b{b_idx}",
                        "text": text_content,
                        "rect": {"l": l, "t": t, "w": w, "h": h},
                        "fontFamily": dominant_font,
                        "fontSize": avg_font_size,
                        "originalFontSizes": font_sizes
                    })
                
                except Exception:
                    # Skip problematic blocks
                    continue

            output_data[page_key] = page_items
    
    finally:
        if doc:
            try:
                doc.close()
            except Exception:
                pass
        
    return output_data

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf_path", help="Path to the PDF file")
    args = parser.parse_args()
    
    result = {}
    
    # We suppress output during processing so MuPDF warnings don't pollute stdout
    try:
        with suppress_output():
            result = get_layout_data(args.pdf_path)
    except Exception as e:
        # If a Python-level error occurs, we capture it
        result = {"error": str(e)}

    # Finally, print the clean JSON to the restored stdout
    print(json.dumps(result))