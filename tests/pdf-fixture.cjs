const app = '1099990000001';
const send = '959999000000001';
const date = '20990102';

function testPdf(lines = ['의견제출통지서', '출원번호 ' + app, '발송번호 ' + send, '2099.01.02', '시험 근거 문장입니다.']) {
  const hex = char => char.charCodeAt(0).toString(16).padStart(4, '0');
  const characters = [...new Set(lines.join(''))];
  const content = ['BT /F1 14 Tf 40 750 Td',
    ...lines.flatMap(line => ['<' + [...line].map(hex).join('') + '> Tj', '0 -25 Td']),
    'ET'].join('\n');
  const cmap = [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Fixture def /CMapType 2 def', '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    characters.length + ' beginbfchar',
    ...characters.map(char => '<' + hex(char) + '> <' + hex(char) + '>'),
    'endbfchar',
    'endcmap CMapName currentdict /CMap defineresource pop end end'
  ].join('\n');
  const stream = text => '<< /Length ' + text.length + ' >>\nstream\n' + text + '\nendstream';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    stream(content),
    '<< /Type /Font /Subtype /Type0 /BaseFont /HYSMyeongJo-Medium /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYSMyeongJo-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R >>',
    stream(cmap),
    '<< /Type /FontDescriptor /FontName /HYSMyeongJo-Medium /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
    return offset;
  });
  const xref = pdf.length;
  pdf += 'xref\n0 9\n0000000000 65535 f \n' + offsets.map(offset =>
    String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return pdf + 'trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
}

module.exports = { app, send, date, testPdf };
