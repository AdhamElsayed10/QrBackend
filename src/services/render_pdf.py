import sys
import os
import pymupdf
import json

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Missing arguments. Usage: render_pdf.py <pdf_path> <output_dir>"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    try:
        doc = pymupdf.open(pdf_path)
        if len(doc) == 0:
            print(json.dumps({"error": "Empty PDF"}))
            sys.exit(1)

        page = doc[0]
        rect = page.rect
        width = rect.width
        height = rect.height

        # Render page 0 at 200 DPI
        pix = page.get_pixmap(dpi=200)
        full_img_path = os.path.join(out_dir, "page_full.png")
        pix.save(full_img_path)

        # Crop key sections for robust OCR:
        # Section 1: Leasor details
        # Section 2: Tenant details
        # Section 3: Leased unit details
        # Section 4: Contract details
        from PIL import Image
        img = Image.open(full_img_path)
        img_w, img_h = img.size

        sections = {
            "leasor": img.crop((0, int(0.14 * img_h), img_w, int(0.25 * img_h))),
            "tenant": img.crop((0, int(0.24 * img_h), img_w, int(0.35 * img_h))),
            "unit": img.crop((0, int(0.34 * img_h), img_w, int(0.50 * img_h))),
            "contract": img.crop((0, int(0.49 * img_h), img_w, int(0.65 * img_h))),
            "footer": img.crop((0, int(0.65 * img_h), img_w, int(0.95 * img_h))),
        }

        section_paths = {}
        for name, crop_img in sections.items():
            c_path = os.path.join(out_dir, f"section_{name}.png")
            crop_img.save(c_path)
            section_paths[name] = c_path

        info = {
            "success": True,
            "pageCount": len(doc),
            "width": width,
            "height": height,
            "dpi": 200,
            "imageWidth": img_w,
            "imageHeight": img_h,
            "fullImagePath": full_img_path,
            "sections": section_paths,
            "text": page.get_text()
        }
        print(json.dumps(info))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()

