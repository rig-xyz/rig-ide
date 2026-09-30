/**
 * A real, minimal PDF for the viewer's tests: `pages` pages of 300 × 400 pt,
 * each a solid blue rectangle (50,50 → 250,350 in PDF space) on white under
 * one line of text, "Quarterly results page N" (Helvetica, not embedded).
 * Returned base64, as `rpc.rig.files.readBinary` returns bytes.
 */
export function tinyPdfBase64(pages: number): string {
  const bodies: string[] = [];
  const kids: string[] = [];
  const font = '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>';
  for (let i = 0; i < pages; i += 1) {
    const pageId = 3 + i * 2;
    const content = `0 0 1 rg 50 50 200 300 re f BT 0 0 0 rg /F1 16 Tf 40 368 Td (Quarterly results page ${i + 1}) Tj ET`;
    kids.push(`${pageId} 0 R`);
    bodies[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources ${font} /Contents ${pageId + 1} 0 R >>`;
    bodies[pageId + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  }
  bodies[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < bodies.length; id += 1) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${bodies[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${bodies.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < bodies.length; id += 1) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return btoa(out);
}
