// Минимальный PDF-билдер без внешних библиотек.
// Вход: [{ data: Uint8Array, width: number, height: number }], изображения должны быть JPEG.
(function (root) {
  'use strict';

  const enc = new TextEncoder();

  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  function ascii(s) { return enc.encode(s); }

  function buildPdf(images) {
    if (!images.length) throw new Error('Нельзя создать пустой PDF.');
    const parts = [ascii('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n')];
    const offsets = [0];
    let offset = parts[0].length;
    let obj = 1;
    const catalog = obj++;
    const pages = obj++;
    const pageObjects = [];
    const imageObjects = [];
    const contentObjects = [];

    for (let i = 0; i < images.length; i++) {
      pageObjects.push(obj++);
      imageObjects.push(obj++);
      contentObjects.push(obj++);
    }

    function addObject(id, bodyParts) {
      offsets[id] = offset;
      const head = ascii(`${id} 0 obj\n`);
      const body = concat(bodyParts);
      const tail = ascii('\nendobj\n');
      parts.push(head, body, tail);
      offset += head.length + body.length + tail.length;
    }

    addObject(catalog, [ascii(`<< /Type /Catalog /Pages ${pages} 0 R >>`)]);
    addObject(pages, [ascii(`<< /Type /Pages /Kids [${pageObjects.map((n) => `${n} 0 R`).join(' ')}] /Count ${images.length} >>`)]);

    images.forEach((img, i) => {
      const page = pageObjects[i];
      const image = imageObjects[i];
      const content = contentObjects[i];
      const w = Math.max(1, Math.round(img.width));
      const h = Math.max(1, Math.round(img.height));
      const stream = ascii(`q\n${w} 0 0 ${h} 0 0 cm\n/Im${i + 1} Do\nQ\n`);

      addObject(page, [ascii(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im${i + 1} ${image} 0 R >> >> /Contents ${content} 0 R >>`)]);
      addObject(image, [ascii(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.data.length} >>\nstream\n`), img.data, ascii('\nendstream')]);
      addObject(content, [ascii(`<< /Length ${stream.length} >>\nstream\n`), stream, ascii('endstream')]);
    });

    const xrefOffset = offset;
    const xref = [ascii(`xref\n0 ${obj}\n`), ascii('0000000000 65535 f \n')];
    for (let i = 1; i < obj; i++) xref.push(ascii(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`));
    xref.push(ascii(`trailer\n<< /Size ${obj} /Root ${catalog} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
    parts.push(...xref);
    return new Blob([concat(parts)], { type: 'application/pdf' });
  }

  root.MLDPdf = { buildPdf };
})(typeof self !== 'undefined' ? self : this);
