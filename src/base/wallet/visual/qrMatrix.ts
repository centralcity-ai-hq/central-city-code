/*
 * The QR matrix for the deposit screen: qrcode-generator (MIT, pinned 1.4.4), error correction M,
 * the smallest version that fits. Kept apart from the components so only the QR pulls it in.
 */
import qrcode from 'qrcode-generator';

/** `matrix[row][col]` is true for a dark module; the matrix is square. */
export function qrMatrix(text: string): boolean[][] {
  const code = qrcode(0, 'M');
  code.addData(text, 'Byte');
  code.make();
  const n = code.getModuleCount();
  return Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, col) => code.isDark(row, col)),
  );
}
