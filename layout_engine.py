import fitz  # PyMuPDF
import json
import sys
import os
import argparse
from contextlib import contextmanager

# Context manager to suppress C-level stdout and stderr
@contextmanager
def suppress_output():
    # Open the null device
    with open(os.devnull, "w") as devnull:
        # Save the original file descriptors
        old_stdout_fd = sys.stdout.fileno()
        old_stderr_fd = sys.stderr.fileno()
        
        saved_stdout_fd = os.dup(old_stdout_fd)
        saved_stderr_fd = os.dup(old_stderr_fd)

        try:
            # Redirect stdout and stderr to devnull
            sys.stdout.flush()
            sys.stderr.flush()
            os.dup2(devnull.fileno(), old_stdout_fd)
            os.dup2(devnull.fileno(), old_stderr_fd)
            yield
        finally:
            # Restore the original file descriptors
            os.dup2(saved_stdout_fd, old_stdout_fd)
            os.dup2(saved_stderr_fd, old_stderr_fd)
            os.close(saved_stdout_fd)
            os.close(saved_stderr_fd)

def get_layout_data(pdf_path):
    # This logic runs inside the suppressed context
    doc = fitz.open(pdf_path)
    output_data = {}

    for page_num, page in enumerate(doc):
        page_key = str(page_num + 1)
        width = page.rect.width
        height = page.rect.height
        
        # 'dict' provides grouped text blocks
        blocks = page.get_text("dict")["blocks"]
        page_items = []

        for b_idx, b in enumerate(blocks):
            if b["type"] != 0: continue # Skip images

            x0, y0, x1, y1 = b['bbox']
            
            l = round(x0 / width, 4)
            t = round(y0 / height, 4)
            w = round((x1 - x0) / width, 4)
            h = round((y1 - y0) / height, 4)

            text_content = ""
            font_sizes = []
            font_families = set()

            for line in b["lines"]:
                line_text = ""
                for span in line["spans"]:
                    span_text = span["text"]
                    line_text += span_text
                    font_sizes.append(round(span["size"], 2))
                    f_name = span["font"].lower()
                    
                    if any(x in f_name for x in ["times", "serif", "roman", "cambria", "garamond"]):
                        font_families.add("serif")
                    elif any(x in f_name for x in ["arial", "sans", "helvetica", "roboto", "calibri"]):
                        font_families.add("sans-serif")
                    else:
                        font_families.add("sans-serif")
                
                text_content += line_text + " "

            text_content = text_content.strip()
            if not text_content: continue

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

        output_data[page_key] = page_items
        
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