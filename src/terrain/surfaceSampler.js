import { TERRAIN } from './params.js';
import { GRASS_COVERAGE } from '../vegetation/grassCoverage.js';

export function captureSurfaceConfig(world) {
  const source = world?.surfaceConfig ?? TERRAIN;
  return { chunkSize: source.chunkSize, resByLevel: [...source.resByLevel], nearRoadCell: source.nearRoadCell,
    nearRoadLevels: source.nearRoadLevels, nearRoadMargin: source.nearRoadMargin, farRidgeNear: source.farRidgeNear };
}

export function terrainResolution(level, size, nearRoad = false, config = TERRAIN) {
  let resolution = config.resByLevel[Math.min(level, config.resByLevel.length - 1)];
  if (level < config.nearRoadLevels && nearRoad) {
    const target = Math.ceil(size / config.nearRoadCell);
    resolution = Math.max(resolution, level === 1 ? Math.min(target, 64) : target);
  }
  return resolution;
}

export function nearRoadCorridorIntersects(world, tile, config = world.surfaceConfig ?? TERRAIN) {
  const route = world.route;
  if (!route) return false;
  const half = tile.C * 0.5;
  const reach = Math.hypot(half, half) + config.nearRoadMargin;
  const x1 = tile.x0 + tile.C, z1 = tile.z0 + tile.C;
  const probes = [[tile.x0 + half, tile.z0 + half], [tile.x0, tile.z0], [x1, tile.z0], [x1, z1], [tile.x0, z1]];
  for (const [x, z] of probes) if (route.nearest(x, z, reach)) return true;
  return false;
}

/** A grass job samples each settled L0 mesh's actual resolution and triangle plane. */
export function createRoadsideSurfaceSampler(world) {
  const config = captureSurfaceConfig(world), size = config.chunkSize;
  const maximumCell = size / terrainResolution(0, size, false, config);
  // Camera-relative ridge displacement cannot be captured by a static root cache.
  if (!(config.farRidgeNear > GRASS_COVERAGE.viewEnd + Math.SQRT2 * maximumCell)) {
    throw new RangeError('Grass surface sampling requires farRidgeNear beyond the visible grass and its supporting L0 triangles');
  }
  const heights = new Map(), tiles = new Map(), corner = {};
  const tileAt = (x, z) => {
    const i = Math.floor(x / size), j = Math.floor(z / size), key = `${i}:${j}`;
    if (!tiles.has(key)) {
      const tile = { x0: i * size, z0: j * size, C: size, l: 0 };
      const nearRoad = config.nearRoadLevels > 0 && nearRoadCorridorIntersects(world, tile, config);
      tile.resolution = terrainResolution(0, size, nearRoad, config);
      tiles.set(key, tile);
    }
    return tiles.get(key);
  };
  const axis = (value, origin, resolution) => {
    const cell = size / resolution, center = origin + size / 2;
    let index = Math.max(0, Math.min(resolution - 1, Math.floor((value - origin) / cell)));
    const vertex = i => center + Math.fround(i * cell - size / 2);
    if (index > 0 && value < vertex(index)) index--;
    else if (index < resolution - 1 && value > vertex(index + 1)) index++;
    return { low: vertex(index), high: vertex(index + 1),
      sampleLow: origin + index * cell, sampleHigh: origin + (index + 1) * cell };
  };
  const height = (x, z) => {
    const key = `${x}:${z}`;
    let value = heights.get(key);
    if (value === undefined) {
      world.sample(x, z, corner);
      value = Math.fround(corner.y);
      heights.set(key, value);
    }
    return value;
  };
  return {
    get cornerCount() { return heights.size; },
    get tileCount() { return tiles.size; },
    sample(x, z, out = {}) {
      // Instance matrices store world translations as Float32 values.
      x = Math.fround(x); z = Math.fround(z);
      const tile = tileAt(x, z);
      const a = axis(x, tile.x0, tile.resolution), b = axis(z, tile.z0, tile.resolution);
      const width = a.high - a.low, depth = b.high - b.low;
      const u = (x - a.low) / width, v = (z - b.low) / depth;
      const east = height(a.sampleHigh, b.sampleLow);
      const south = height(a.sampleLow, b.sampleHigh);
      if (u + v <= 1) {
        const northwest = height(a.sampleLow, b.sampleLow);
        out.dx = (east - northwest) / width;
        out.dz = (south - northwest) / depth;
        out.y = northwest + out.dx * (x - a.low) + out.dz * (z - b.low);
      } else {
        const southeast = height(a.sampleHigh, b.sampleHigh);
        out.dx = (southeast - south) / width;
        out.dz = (southeast - east) / depth;
        out.y = southeast + out.dx * (x - a.high) + out.dz * (z - b.high);
      }
      return out;
    },
  };
}
