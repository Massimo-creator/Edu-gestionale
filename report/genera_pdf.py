"""Genera il PDF del report CAS su carta intestata Metis 2026.

Uso: python3 genera_pdf.py <file.html> <file.pdf> <numero_report>
Intestazione e piè di pagina riproducono 'carta intestata metis 2026.docx'
(logo, dati della cooperativa, colori grigio #5B6868, rosso #E94338, arancio #F0A11B).
"""
import asyncio, base64, os, sys
from playwright.async_api import async_playwright

QUI = os.path.dirname(os.path.abspath(__file__))
LOGO = base64.b64encode(open(os.path.join(QUI, "logo_metis.png"), "rb").read()).decode()

def intestazione():
    lab = 'style="color:#F0A11B;font-weight:700;letter-spacing:.02em"'
    return f"""
<div style="width:100%;padding:0 16.5mm;font-family:Inter,'DejaVu Sans',sans-serif;-webkit-print-color-adjust:exact;display:flex;align-items:flex-start;justify-content:space-between;">
  <img src="data:image/png;base64,{LOGO}" style="width:52mm;height:auto;margin-top:2mm">
  <div style="font-size:6.6pt;line-height:1.55;color:#5B6868;text-align:left;margin-top:3mm;width:78mm">
    <div style="font-size:8.2pt;font-weight:700;color:#3d4747">COOPERATIVA SOCIALE METIS <span style="font-size:6.4pt;color:#E94338;font-weight:700">SOCIETÀ COOPERATIVA</span></div>
    <div><span {lab}>SEDE LEGALE</span>&nbsp; Via Caduti di Marzabotto n. 36 · 47922 Rimini RN</div>
    <div><span {lab}>SEDE OPERATIVA</span>&nbsp; Via Sirani n. 5 · 47923 Rimini RN</div>
    <div><span {lab}>TEL</span>&nbsp; 0541 081.779 &nbsp;&nbsp;<span {lab}>FAX</span>&nbsp; 0541 179.36.28</div>
    <div><span {lab}>EMAIL</span>&nbsp; info@coopmetis.com &nbsp;&nbsp;<span {lab}>PEC</span>&nbsp; coopmetis@pec.it</div>
    <div><span {lab}>C.F. · P. IVA · REG. IMPRESE RN</span>&nbsp; 03393260405 &nbsp;&nbsp;<span {lab}>C.U.</span>&nbsp; C3UCNRB</div>
  </div>
</div>"""

def piede(numero):
    return f"""
<div style="width:100%;padding:0 16.5mm;font-family:Inter,'DejaVu Sans',sans-serif;-webkit-print-color-adjust:exact;">
  <div style="border-top:0.6pt solid #5B6868;display:flex;justify-content:space-between;align-items:center;padding-top:1.5mm;font-size:6.6pt;color:#5B6868;letter-spacing:.06em">
    <span style="color:#E94338;font-weight:700">METIS</span>
    <span>COOPERATIVA SOCIALE · REPORT STRUTTURE CAS N. {numero}</span>
    <span style="font-weight:700">PAGINA&nbsp; <span class="pageNumber"></span> / <span class="totalPages"></span></span>
  </div>
</div>"""

async def main(html, pdf, numero):
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        pg = await b.new_page()
        await pg.goto("file://" + os.path.abspath(html))
        await pg.wait_for_timeout(400)
        await pg.pdf(path=pdf, format="A4", print_background=True,
                     margin={"top": "44mm", "bottom": "20mm", "left": "16.5mm", "right": "16.5mm"},
                     display_header_footer=True, header_template=intestazione(), footer_template=piede(numero))
        await b.close()

if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3]))
