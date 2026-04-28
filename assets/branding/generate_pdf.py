"""
generate_pdf.py — ProspectorAI Logo Sheet
Generates a 2-page PDF: page 1 white bg, page 2 dark bg.
"""

from svglib.svglib import svg2rlg
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.graphics import renderPDF
from reportlab.lib.utils import ImageReader
import os

BRANDING = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BRANDING, "ProspectorAI-Logos.pdf")

W, H = A4  # 595 x 842 pt

SVGS = {
    "logo-full":  os.path.join(BRANDING, "logo-full.svg"),
    "icon-1024":  os.path.join(BRANDING, "icon-1024.svg"),
    "icon-64":    os.path.join(BRANDING, "icon-64.svg"),
    "favicon-32": os.path.join(BRANDING, "favicon-32.svg"),
}

GOLD   = colors.HexColor("#D4A017")
CYAN   = colors.HexColor("#00BFFF")
DARK   = colors.HexColor("#0A0A0A")
GRAY   = colors.HexColor("#888888")
WHITE  = colors.white
BLACK  = colors.black

def draw_page(c: canvas.Canvas, bg: colors.Color, fg: colors.Color, label_color: colors.Color):
    # Background
    c.setFillColor(bg)
    c.rect(0, 0, W, H, fill=1, stroke=0)

    # Title
    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 22)
    c.drawCentredString(W / 2, H - 2.2*cm, "ProspectorAI — Brand Identity")

    # Subtitle
    c.setFillColor(label_color)
    c.setFont("Helvetica", 10)
    bg_name = "Light Background" if bg == WHITE else "Dark Background"
    c.drawCentredString(W / 2, H - 2.9*cm, f"Logo Sheet · {bg_name}")

    # Thin gold rule
    c.setStrokeColor(GOLD)
    c.setLineWidth(0.5)
    c.line(1.8*cm, H - 3.3*cm, W - 1.8*cm, H - 3.3*cm)

    # ── SECTION 1: Full Logo ──────────────────────────────────────────────
    section_y = H - 4.0*cm

    c.setFillColor(label_color)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(1.8*cm, section_y, "01 · FULL LOGO (horizontal lockup)")

    c.setFont("Helvetica", 8)
    c.setFillColor(GRAY)
    c.drawRightString(W - 1.8*cm, section_y, "480 × 120 · SVG")

    drw = svg2rlg(SVGS["logo-full"])
    if drw:
        # Scale to fit width ~16cm
        target_w = 15.5 * cm
        scale = target_w / drw.width
        drw.width  *= scale
        drw.height *= scale
        drw.transform = (scale, 0, 0, scale, 0, 0)
        y_pos = section_y - drw.height - 0.4*cm
        renderPDF.draw(drw, c, (W - drw.width) / 2, y_pos)

        # Border rect around it
        c.setStrokeColor(colors.HexColor("#333333") if bg == DARK else colors.HexColor("#DDDDDD"))
        c.setLineWidth(0.4)
        c.rect((W - drw.width) / 2 - 4, y_pos - 4, drw.width + 8, drw.height + 8)

        next_y = y_pos - 0.8*cm
    else:
        next_y = section_y - 4*cm

    # ── SECTION 2: App Icon 1024 ──────────────────────────────────────────
    c.setFillColor(label_color)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(1.8*cm, next_y, "02 · APP ICON  (square, 1024 × 1024)")

    c.setFont("Helvetica", 8)
    c.setFillColor(GRAY)
    c.drawRightString(W - 1.8*cm, next_y, "1024 × 1024 · SVG")

    drw2 = svg2rlg(SVGS["icon-1024"])
    if drw2:
        target_w2 = 7.5 * cm
        scale2 = target_w2 / drw2.width
        drw2.width  *= scale2
        drw2.height *= scale2
        drw2.transform = (scale2, 0, 0, scale2, 0, 0)
        y2 = next_y - drw2.height - 0.4*cm
        x2 = (W - drw2.width) / 2
        renderPDF.draw(drw2, c, x2, y2)
        c.setStrokeColor(colors.HexColor("#333333") if bg == DARK else colors.HexColor("#DDDDDD"))
        c.setLineWidth(0.4)
        c.rect(x2 - 4, y2 - 4, drw2.width + 8, drw2.height + 8)
        next_y2 = y2 - 0.8*cm
    else:
        next_y2 = next_y - 8*cm

    # ── SECTION 3: Small icons side by side ──────────────────────────────
    c.setFillColor(label_color)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(1.8*cm, next_y2, "03 · SMALL SIZES")

    c.setFont("Helvetica", 8)
    c.setFillColor(GRAY)
    c.drawRightString(W - 1.8*cm, next_y2, "64 × 64  and  32 × 32")

    small_entries = [
        ("icon-64",    "Icon 64 × 64",    SVGS["icon-64"],    3.5*cm),
        ("favicon-32", "Favicon 32 × 32", SVGS["favicon-32"], 2.0*cm),
    ]

    x_cursor = 1.8*cm
    for key, label, path, target in small_entries:
        drw_s = svg2rlg(path)
        if not drw_s:
            continue
        scale_s = target / drw_s.width
        drw_s.width  *= scale_s
        drw_s.height *= scale_s
        drw_s.transform = (scale_s, 0, 0, scale_s, 0, 0)
        y_s = next_y2 - drw_s.height - 0.6*cm
        renderPDF.draw(drw_s, c, x_cursor, y_s)

        # Checkerboard hint + border
        c.setStrokeColor(colors.HexColor("#444") if bg == DARK else colors.HexColor("#CCC"))
        c.setLineWidth(0.4)
        c.rect(x_cursor - 2, y_s - 2, drw_s.width + 4, drw_s.height + 4)

        # Sub-label
        c.setFillColor(GRAY)
        c.setFont("Helvetica", 7)
        c.drawCentredString(x_cursor + drw_s.width / 2, y_s - 0.5*cm, label)

        x_cursor += drw_s.width + 2.0*cm

    # ── Color palette strip ───────────────────────────────────────────────
    palette_y = 1.5*cm
    swatch_w  = 2.2*cm
    swatch_h  = 0.7*cm
    palette = [
        ("#D4A017", "Gold  #D4A017"),
        ("#00BFFF", "Cyan  #00BFFF"),
        ("#0A0A0A", "Dark  #0A0A0A"),
        ("#888888", "Gray  #888888"),
        ("#FFFFFF", "White #FFFFFF"),
    ]
    total_w = len(palette) * (swatch_w + 0.3*cm) - 0.3*cm
    px = (W - total_w) / 2
    for hex_col, lbl in palette:
        col = colors.HexColor(hex_col)
        c.setFillColor(col)
        c.setStrokeColor(colors.HexColor("#555555") if bg == DARK else colors.HexColor("#AAAAAA"))
        c.setLineWidth(0.3)
        c.rect(px, palette_y + 0.3*cm, swatch_w, swatch_h, fill=1, stroke=1)
        c.setFillColor(label_color)
        c.setFont("Helvetica", 6)
        c.drawCentredString(px + swatch_w / 2, palette_y + 0.1*cm, lbl)
        px += swatch_w + 0.3*cm

    # Footer
    c.setFillColor(GRAY)
    c.setFont("Helvetica", 7)
    c.drawCentredString(W / 2, 0.6*cm, "ProspectorAI · Mineral Intelligence · Satellite Grade")

    c.showPage()


def main():
    c = canvas.Canvas(OUT, pagesize=A4)
    c.setTitle("ProspectorAI — Logo Sheet")
    c.setAuthor("ProspectorAI")

    # Page 1: Dark background
    draw_page(c, bg=DARK, fg=WHITE, label_color=WHITE)

    # Page 2: White background
    draw_page(c, bg=WHITE, fg=BLACK, label_color=colors.HexColor("#222222"))

    c.save()
    print(f"PDF saved → {OUT}")


if __name__ == "__main__":
    main()
