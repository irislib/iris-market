import qrcode from 'qrcode-generator';

/** Local presentation only. This neither requests an invoice nor claims payment. */
export function lightningPresentation(value: string): { uri: string; image: string } | undefined {
  const invoice = value.trim().replace(/^lightning:/i, '');
  // Accept only a bounded BOLT11 payload, never a mint-supplied arbitrary URI.
  if (invoice.length > 4096 || invoice.length < 100 ||
      invoice !== invoice.toLowerCase() && invoice !== invoice.toUpperCase() ||
      !/^ln(?:bc|tb|bcrt)[0-9]*[munp]?1[023456789acdefghjklmnpqrstuvwxyz]+$/i.test(invoice)) return;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(invoice.toUpperCase(), 'Alphanumeric');
    qr.make();
    // Four-module white quiet zone, including in dark mode. No remote QR service.
    const svg = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
    return { uri: 'lightning:' + invoice.toLowerCase(), image: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) };
  } catch { return; } // Copy remains available if a very large invoice cannot fit.
}
