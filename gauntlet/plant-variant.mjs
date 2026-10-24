export function plantVariantQuery(query, variant = process.env.GAUNTLET_PLANTS) {
  if (!variant) return query;
  if (!['baseline', 'study'].includes(variant)) throw new Error(`Invalid GAUNTLET_PLANTS: ${variant}`);
  const params = new URLSearchParams(query);
  params.set('plants', variant);
  return params.toString();
}
