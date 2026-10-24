const species = (evergreen, silhouette, barkMap, leafMap, barkTint, leafTint, heightRange, widthRatio) => Object.freeze({
  evergreen, silhouette, barkMap, leafMap,
  barkTint: Object.freeze(barkTint), leafTint: Object.freeze(leafTint),
  heightRange: Object.freeze(heightRange), widthRatio: Object.freeze(widthRatio),
});

export const TREE_SPECIES = Object.freeze({
  pine: species(true, 'open conical crown', 'pine_color_1k.jpg', 'pine_color.png', [1, 1, 1], [1, 1, 1], [15, 28], [0.35, 0.55]),
  oak: species(false, 'spreading irregular crown', 'oak_color_1k.jpg', 'oak_color.png', [1, 1, 1], [1, 1, 1], [14, 24], [0.62, 0.88]),
  birch: species(false, 'airy forked crown', 'birch_color_1k.jpg', 'aspen_color.png', [1, 1, 1], [0.52, 1.40, 0.95], [14, 24], [0.52, 0.73]),
  aspen: species(false, 'narrow upright crown', 'birch_color_1k.jpg', 'aspen_color.png', [0.91, 0.95, 0.88], [0.46, 1.45, 0.85], [17, 29], [0.25, 0.40]),
  maple: species(false, 'broad rounded crown', 'oak_color_1k.jpg', 'oak_color.png', [0.88, 0.91, 0.88], [1.03, 0.95, 0.89], [13, 23], [0.76, 1.02]),
  spruce: species(true, 'dense low tapering crown', 'pine_color_1k.jpg', 'pine_color.png', [0.88, 0.91, 0.94], [0.79, 0.92, 0.93], [17, 30], [0.48, 0.66]),
});

export const TREE_SPECIES_NAMES = Object.freeze(Object.keys(TREE_SPECIES));
export const EXTRA_TREE_SPECIES_NAMES = Object.freeze(['birch', 'aspen', 'maple', 'spruce']);

export function isEvergreenSpecies(name) {
  return TREE_SPECIES[name]?.evergreen === true;
}

// Population workers import the metadata above; keep Three.js out of that path.
export async function loadTreeSpecies(fetcher = globalThis.fetch) {
  const { loadTreeSpeciesAssets } = await import('./treeSpeciesAssets.js');
  return loadTreeSpeciesAssets(fetcher);
}
