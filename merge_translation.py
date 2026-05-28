#!/usr/bin/env python3
"""
PDF Translation Merger using PyMuPDF (fitz)
Receives JSON payload via stdin, outputs merged PDF path via stdout
"""
import sys
import json
import fitz  # PyMuPDF
import os
from pathlib import Path

def main():
    try:
        # Read JSON payload from stdin
        payload = json.load(sys.stdin)
        pdf_path = payload['pdfPath']
        translations = payload['translations']
        options = payload['options']
        
        # Open PDF
        doc = fitz.open(pdf_path)
        
        # Process each page's translations
        for page_data in translations:
            page_num = page_data['page'] - 1  # PyMuPDF uses 0-based indexing
            if page_num >= len(doc):
                continue
                
            page = doc[page_num]
            page_rect = page.rect
            
            for item in page_data['items']:
                # Convert relative coordinates to absolute PDF coordinates
                rect = fitz.Rect(
                    item['rect']['left'] * page_rect.width,
                    item['rect']['top'] * page_rect.height,
                    (item['rect']['left'] + item['rect']['width']) * page_rect.width,
                    (item['rect']['top'] + item['rect']['height']) * page_rect.height,
                )
                
                # Calculate font size (scaled)
                font_size = item.get('fontSize', 12) * options.get('fontSizeScale', 0.95)
                
                # Add text - two modes:
                if options.get('addAsAnnotation', False):
                    # Annotation mode (preserves original PDF structure)
                    annot = page.add_freetext_annot(
                        rect,
                        item['text'],
                        fontsize=font_size,
                        fontname="helv",  # PyMuPDF built-in font
                        text_color=tuple(int(options['textColor'].lstrip('#')[i:i+2], 16)/255 
                                       for i in (0, 2, 4)),
                        fill_color=(1, 1, 1, options.get('textOpacity', 0.85)),  # RGBA
                    )
                    annot.update()
                else:
                    # Direct text insertion (becomes part of page content)
                    page.insert_textbox(
                        rect,
                        item['text'],
                        fontsize=font_size,
                        fontname="helv",
                        color=tuple(int(options['textColor'].lstrip('#')[i:i+2], 16)/255 
                                  for i in (0, 2, 4)),
                        fill=(1, 1, 1, options.get('textOpacity', 0.85)),
                        align=0,  # left align
                    )
        
        # Determine output path
        output_dir = payload.get('outputDirectory', '')
        if not output_dir:
            output_dir = os.path.dirname(pdf_path)
        
        output_name = f"{Path(pdf_path).stem}_translated.pdf"
        output_path = os.path.join(output_dir, output_name)
        
        # Save with garbage collection to minimize size
        doc.save(output_path, garbage=4, deflate=True)
        doc.close()
        
        # Return success response
        result = {
            "success": True,
            "outputPath": output_path,
            "pagesProcessed": len(translations)
        }
        json.dump(result, sys.stdout)
        
    except Exception as e:
        # Return error response
        error_result = {
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc() if 'traceback' in sys.modules else str(e)
        }
        json.dump(error_result, sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    import traceback
    main()