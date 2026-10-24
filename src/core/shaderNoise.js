// Match hash2i's integer mixing. Float fract(p * largeConstant) loses all
// fractional bits for fine material samples kilometres from the origin.
export const SURFACE_HASH_GLSL = /* glsl */`
float surfaceHash(vec2 p) {
  uvec2 cell = uvec2(ivec2(p));
  uint h = (cell.x * 0x8da6b343u) ^ (cell.y * 0xd8163841u);
  h ^= h >> 15u;
  h *= 0x2c1b3c6du;
  h ^= h >> 12u;
  h *= 0x297a2d39u;
  h ^= h >> 15u;
  return float(h >> 8u) / 16777216.0;
}
`;
