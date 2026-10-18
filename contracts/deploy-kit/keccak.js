// Keccak-256 (the Ethereum hash, original padding 0x01), dependency-free, for the deploy kit's
// bytecode check. Input: Uint8Array. Output: lowercase 0x-hex. BigInt lanes: slow but small inputs.
(function () {
  const MASK = (1n << 64n) - 1n;
  const RC = [
    0x0000000000000001n,
    0x0000000000008082n,
    0x800000000000808an,
    0x8000000080008000n,
    0x000000000000808bn,
    0x0000000080000001n,
    0x8000000080008081n,
    0x8000000000008009n,
    0x000000000000008an,
    0x0000000000000088n,
    0x0000000080008009n,
    0x000000008000000an,
    0x000000008000808bn,
    0x800000000000008bn,
    0x8000000000008089n,
    0x8000000000008003n,
    0x8000000000008002n,
    0x8000000000000080n,
    0x000000000000800an,
    0x800000008000000an,
    0x8000000080008081n,
    0x8000000000008080n,
    0x0000000080000001n,
    0x8000000080008008n,
  ];
  const ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
  ];
  const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);
  function f(A) {
    for (let round = 0; round < 24; round++) {
      const C = [0, 1, 2, 3, 4].map((x) => A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4]);
      for (let x = 0; x < 5; x++) {
        const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
        for (let y = 0; y < 5; y++) A[x][y] ^= D;
      }
      const B = [...Array(5)].map(() => Array(5).fill(0n));
      for (let x = 0; x < 5; x++)
        for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rotl(A[x][y], ROT[x][y]);
      for (let x = 0; x < 5; x++)
        for (let y = 0; y < 5; y++)
          A[x][y] = B[x][y] ^ (~B[(x + 1) % 5][y] & MASK & B[(x + 2) % 5][y]);
      A[0][0] ^= RC[round];
    }
  }
  function keccak256(bytes) {
    const rate = 136;
    const len = bytes.length;
    const padded = new Uint8Array(Math.ceil((len + 1) / rate) * rate);
    padded.set(bytes);
    padded[len] ^= 0x01;
    padded[padded.length - 1] ^= 0x80;
    const A = [...Array(5)].map(() => Array(5).fill(0n));
    for (let off = 0; off < padded.length; off += rate) {
      for (let i = 0; i < rate / 8; i++) {
        let lane = 0n;
        for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
        A[i % 5][Math.floor(i / 5)] ^= lane;
      }
      f(A);
    }
    let out = '0x';
    for (let i = 0; i < 4; i++) {
      let lane = A[i % 5][Math.floor(i / 5)];
      for (let b = 0; b < 8; b++) {
        out += Number(lane & 0xffn)
          .toString(16)
          .padStart(2, '0');
        lane >>= 8n;
      }
    }
    return out;
  }
  const hexToBytes = (hex) => {
    const h = hex.replace(/^0x/, '');
    if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('bad hex');
    return Uint8Array.from(h.match(/../g) || [], (b) => parseInt(b, 16));
  };
  const api = { keccak256, hexToBytes };
  if (typeof module !== 'undefined') module.exports = api;
  else window.kitKeccak = api;
})();
