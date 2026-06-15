// Deterministic, dependency-free avatar generated from a wallet address — a
// stable, unique fallback used whenever a wallet has no resolvable NFT image.
// Renders a mirrored 5×5 "blockie"-style grid as an inline SVG data URI.

// FNV-1a → seed; then a small xorshift PRNG so the pattern is stable per seed.
function makePrng(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let state = h >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/** A `data:image/svg+xml` avatar derived from `seed` (a wallet address). */
export function identiconDataUri(seed: string): string {
  const rng = makePrng(seed.toLowerCase());
  const hue = Math.floor(rng() * 360);
  const fg = `hsl(${hue} 62% 58%)`;
  const accent = `hsl(${(hue + 40) % 360} 70% 64%)`;
  const bg = `hsl(${(hue + 200) % 360} 30% 16%)`;

  const cells: string[] = [];
  const SIZE = 5;
  const SCALE = 16; // px per cell
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < Math.ceil(SIZE / 2); x++) {
      if (rng() > 0.5) {
        const color = rng() > 0.75 ? accent : fg;
        const mirror = SIZE - 1 - x;
        for (const cx of x === mirror ? [x] : [x, mirror]) {
          cells.push(
            `<rect x="${cx * SCALE}" y="${y * SCALE}" width="${SCALE}" height="${SCALE}" fill="${color}"/>`
          );
        }
      }
    }
  }

  const px = SIZE * SCALE;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">` +
    `<rect width="${px}" height="${px}" fill="${bg}"/>${cells.join("")}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
