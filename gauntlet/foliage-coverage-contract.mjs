import { isEvergreenSpecies } from '../src/vegetation/treeSpecies.js';

export function foliageCoverageContract(input) {
  const templates = [...input], issues = [];
  let mips = true, views = true, sourceNames = true, fernGeometry = true, fernColor = true;
  let ferns = 0, texturedLeaves = 0;
  const coverageTexture = (texture, label) => {
    const levels = texture?.mipmaps;
    const valid = Boolean(texture?.isDataTexture && texture.generateMipmaps === false && Array.isArray(levels) &&
      levels.length > 1 && levels[0].width === texture.image?.width && levels[0].height === texture.image?.height &&
      levels.at(-1).width === 1 && levels.at(-1).height === 1 && texture.anisotropy >= 4 && texture.colorSpace === 'srgb');
    if (!valid) issues.push(`${label}: missing or invalid coverage mip texture`);
    mips &&= valid;
  };
  const atlas = (value, name, bare = false) => {
    const label = `${name}.${bare ? 'bareImpostor' : 'impostor'}`;
    coverageTexture(value?.texture, label);
    const validViews = value?.views === 8 && value.columns === 4 && value.rows === 2;
    const validName = value?.texture?.name === `${name}-${bare ? 'bare-' : ''}same-source-impostor`;
    if (!validViews) issues.push(`${label}: missing or invalid eight-view atlas`);
    if (!validName) issues.push(`${label}: invalid same-source texture name`);
    views &&= validViews; sourceNames &&= validName;
  };
  const geometryData = geometry => {
    const position = geometry?.getAttribute?.('position'), normal = geometry?.getAttribute?.('normal');
    const index = geometry?.index;
    if (!position || !normal || position.itemSize !== 3 || normal.itemSize !== 3 ||
      position.count !== normal.count || !position.array.every(Number.isFinite) || !normal.array.every(Number.isFinite)) return null;
    const count = index ? index.count : position.count;
    if (count <= 0 || count % 3 !== 0) return null;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < position.count; i++) {
      minY = Math.min(minY, position.array[i * 3 + 1]); maxY = Math.max(maxY, position.array[i * 3 + 1]);
    }
    for (let i = 0; i < count; i += 3) {
      const a = index ? index.array[i] : i, b = index ? index.array[i + 1] : i + 1, c = index ? index.array[i + 2] : i + 2;
      if (![a, b, c].every(value => Number.isInteger(value) && value >= 0 && value < position.count)) return null;
      const p = position.array, ax = p[b * 3] - p[a * 3], ay = p[b * 3 + 1] - p[a * 3 + 1], az = p[b * 3 + 2] - p[a * 3 + 2];
      const bx = p[c * 3] - p[a * 3], by = p[c * 3 + 1] - p[a * 3 + 1], bz = p[c * 3 + 2] - p[a * 3 + 2];
      if ((ay * bz - az * by) ** 2 + (az * bx - ax * bz) ** 2 + (ax * by - ay * bx) ** 2 <= 1e-16) return null;
    }
    return { triangles: count / 3, vertices: position.count, minY, maxY };
  };
  for (const template of templates) {
    if (template.growthForm === 'fern') {
      ferns++;
      const bark = geometryData(template.parts?.bark), leaf = geometryData(template.parts?.leaf);
      const total = (bark?.triangles || 0) + (leaf?.triangles || 0);
      const validGeometry = Boolean(template.kind === 'shrub' && bark && leaf && leaf.vertices >= 100 &&
        total >= 300 && total <= 800 && Math.abs(bark.minY) < 1e-5 && leaf.maxY - leaf.minY > 0.1);
      const tint = template.tints?.leaf;
      const validColor = Boolean(Array.isArray(tint) && tint.length === 3 &&
        tint.every(value => Number.isFinite(value) && value >= 0 && value <= 1) && tint[1] > Math.max(tint[0], tint[2], 0.05));
      if (!validGeometry) issues.push(`${template.name}: fern requires nondegenerate rooted leaf geometry`);
      if (!validColor) issues.push(`${template.name}: fern requires a valid green leaf tint`);
      fernGeometry &&= validGeometry; fernColor &&= validColor;
    }
    if (template.maps?.leaf != null || template.growthForm !== 'fern') {
      coverageTexture(template.maps?.leaf, `${template.name}.leaf`);
      if (template.maps?.leaf) texturedLeaves++;
    }
    atlas(template.impostor, template.name);
    if (!isEvergreenSpecies(template.species) || template.bareImpostor) atlas(template.bareImpostor, template.name, true);
  }
  const ok = templates.length === 8 && ferns === 1 && mips && views && sourceNames && fernGeometry && fernColor;
  return { templates: templates.length, ferns, texturedLeaves, mips, views, sourceNames, fernGeometry, fernColor, ok, issues };
}
