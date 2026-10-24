import { clamp, smoothstep } from '../core/rng.js';
import { World } from '../world/world.js';
import { grassClump, forestCover, roadsideTreeCover } from '../vegetation/biome.js';
import { captureSurfaceConfig } from './surfaceSampler.js';
import { buildWaterData } from '../water/mesh-data.js';

const ROUTE_FIELDS = [
  'seed', 'kmZero', 'cellSize', 'n', 'ds', 'length', 'bridges', 'grid',
  'X', 'Y', 'Z', 'TX', 'TZ', 'CURV', 'GRADE', 'BR',
];

// Workers receive the already-routed road once, not a route rebuild per tile.
export function serializeWorld(world) {
  const route = {};
  for (const key of ROUTE_FIELDS) route[key] = world.route[key];
  return { seedInput: world.seedInput, route, surfaceConfig: captureSurfaceConfig(world) };
}

export function hydrateWorld(snapshot) {
  const world = new World(snapshot.seedInput);
  Object.assign(world.route, snapshot.route);
  if (snapshot.surfaceConfig) world.surfaceConfig = captureSurfaceConfig(snapshot);
  return world;
}

export function* buildTerrainTileData(world, tile, options) {
  const data = yield* buildTerrainData(world, tile, options);
  if (options.waterResolution !== undefined) {
    const cell = tile.C / data.resolution;
    const groundAt = (x, z) => {
      const i = Math.round((x - tile.x0) / cell), j = Math.round((z - tile.z0) / cell);
      if (i >= -1 && i <= data.resolution + 1 && j >= -1 && j <= data.resolution + 1) {
        return data.heights[(j + 1) * data.gridSize + i + 1];
      }
      return world.ground(x, z);
    };
    data.water = yield* buildWaterData(world, tile.x0, tile.z0, tile.C, options.waterResolution, groundAt);
  }
  return data;
}

/** Renderer-independent terrain buffers; row yields also support the fallback. */
export function* buildTerrainData(world, r, { resolution: N, skirtDepth }) {
  if (!Number.isInteger(N) || N < 1 || N > 512) throw new RangeError('Invalid terrain resolution');
  if (!Number.isFinite(skirtDepth) || skirtDepth < 0) throw new RangeError('Invalid terrain skirt depth');
  const C = r.C, cell = C / N, S = N + 3;
  const H = new Float32Array(S * S);
  const surf = new Float32Array((N + 1) * (N + 1) * 4);
  const eco = new Float32Array((N + 1) * (N + 1) * 2);
  const roadDist = new Float32Array((N + 1) * (N + 1));
  const ox = r.x0, oz = r.z0, cx = ox + C / 2, cz = oz + C / 2;
  const seed = world.seed >>> 0, biomeSeed = seed ^ 0x2b7c1f03;
  const probeDistance = 150 + C * Math.SQRT1_2;
  // Large clipmap tiles use bounded per-point searches, never a tile-sized radius.
  const probeRoad = Boolean(world.route?.nearest) && (C > 512
    || (world.route.nearest(cx, cz, probeDistance)?.dist ?? Infinity) <= probeDistance);
  const sm = {};
  const pos = new Float32Array((N + 1) * (N + 1) * 3);
  const nrm = new Float32Array((N + 1) * (N + 1) * 3);

  for (let j = 0; j <= N; j++) {
    const z = oz + j * cell;
    for (let i = 0; i <= N; i++) {
      const x = ox + i * cell;
      world.sample(x, z, sm);
      H[(j + 1) * S + (i + 1)] = sm.y;
      const k4 = (j * (N + 1) + i) * 4;
      surf[k4] = sm.moisture;
      surf[k4 + 1] = sm.rockiness;
      surf[k4 + 2] = sm.riverDist < sm.channelHalf * 3.2
        ? clamp(smoothstep(sm.waterY + 2.2, sm.waterY - 0.4, sm.y)
          * smoothstep(sm.channelHalf * 3.2, sm.channelHalf * 0.8, sm.riverDist), 0, 1)
        : 0;
      surf[k4 + 3] = sm.y;
      roadDist[j * (N + 1) + i] = Math.min(sm.roadDist, 255);
      const k2 = (j * (N + 1) + i) * 2;
      eco[k2] = roadsideTreeCover(world, x, z, sm.roadDist, forestCover(x, z, biomeSeed), biomeSeed, probeRoad);
      eco[k2 + 1] = grassClump(x, z, seed);
    }
    if ((j & 3) === 3) yield;
  }
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      if (i > 0 && i < S - 1 && j > 0 && j < S - 1) continue;
      H[j * S + i] = world.ground(ox + (i - 1) * cell, oz + (j - 1) * cell);
    }
    if ((j & 7) === 7) yield;
  }

  let minY = Infinity, maxY = -Infinity;
  for (let j = 0; j <= N; j++) {
    const z = oz + j * cell;
    for (let i = 0; i <= N; i++) {
      const x = ox + i * cell;
      const hi = (j + 1) * S + (i + 1), y = H[hi];
      const k3 = (j * (N + 1) + i) * 3;
      pos[k3] = x - cx; pos[k3 + 1] = y; pos[k3 + 2] = z - cz;
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      const nx = H[hi - 1] - H[hi + 1], nz = H[hi - S] - H[hi + S], ny = 2 * cell;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nrm[k3] = nx * inv; nrm[k3 + 1] = ny * inv; nrm[k3 + 2] = nz * inv;
      const slope = clamp(1 - ny * inv, 0, 1), k4 = (j * (N + 1) + i) * 4;
      surf[k4 + 1] = clamp(slope * 1.7 + (surf[k4 + 1] - 0.55) * 0.55, 0, 1);
    }
    if ((j & 3) === 3) yield;
  }

  const totalVerts = (N + 1) * (N + 1) + (N + 1) * 4;
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const surface = new Float32Array(totalVerts * 4);
  const roadDistances = new Float32Array(totalVerts);
  const ecology = new Float32Array(totalVerts * 2);
  positions.set(pos); normals.set(nrm); surface.set(surf); roadDistances.set(roadDist);
  ecology.set(eco);
  const indices = new Uint32Array(N * N * 6 + N * 4 * 6);
  let ii = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + (N + 1), d = c + 1;
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
    }
  }
  let sv = (N + 1) * (N + 1);
  const edge = (getIdx, flip) => {
    const first = sv;
    for (let i = 0; i <= N; i++) {
      const src = getIdx(i);
      positions[sv * 3] = pos[src * 3];
      positions[sv * 3 + 1] = pos[src * 3 + 1] - skirtDepth;
      positions[sv * 3 + 2] = pos[src * 3 + 2];
      normals[sv * 3] = nrm[src * 3]; normals[sv * 3 + 1] = nrm[src * 3 + 1]; normals[sv * 3 + 2] = nrm[src * 3 + 2];
      surface[sv * 4] = surf[src * 4]; surface[sv * 4 + 1] = surf[src * 4 + 1];
      surface[sv * 4 + 2] = surf[src * 4 + 2]; surface[sv * 4 + 3] = surf[src * 4 + 3];
      roadDistances[sv] = roadDist[src];
      ecology[sv * 2] = eco[src * 2]; ecology[sv * 2 + 1] = eco[src * 2 + 1];
      sv++;
    }
    for (let i = 0; i < N; i++) {
      const a = getIdx(i), b = getIdx(i + 1), c = first + i, d = first + i + 1;
      if (flip) {
        indices[ii++] = a; indices[ii++] = b; indices[ii++] = c;
        indices[ii++] = b; indices[ii++] = d; indices[ii++] = c;
      } else {
        indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
        indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
      }
    }
  };
  edge((i) => i, true);
  edge((i) => N * (N + 1) + i, false);
  edge((j) => j * (N + 1), false);
  edge((j) => j * (N + 1) + N, true);
  yield;
  return {
    positions, normals, surface, roadDistances, ecology, indices, minY, maxY,
    heights: H, resolution: N, gridSize: S, skirtDepth,
  };
}

/** Close each quadrant's internal cut edges before the mesh index is partitioned. */
export function addQuadrantSkirts(data, depth, outerDepth = data.skirtDepth ?? 60) {
  const N = data.resolution, stride = N + 1, baseCount = stride * stride;
  if (!Number.isInteger(N) || N < 2 || N % 2 !== 0) {
    throw new RangeError('Quadrant skirts require an even terrain resolution');
  }
  if (!Number.isFinite(depth) || depth <= 0 || !Number.isFinite(outerDepth) || outerDepth < 0) {
    throw new RangeError('Invalid quadrant skirt depth');
  }
  const originalCount = data.positions.length / 3;
  const count = originalCount + stride * 4;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const surface = new Float32Array(count * 4);
  const roadDistances = new Float32Array(count);
  const ecology = new Float32Array(count * 2);
  const skirtDepths = new Float32Array(count);
  const indices = new Uint32Array(data.indices.length + N * 4 * 6);
  positions.set(data.positions); normals.set(data.normals);
  surface.set(data.surface); roadDistances.set(data.roadDistances);
  ecology.set(data.ecology);
  indices.set(data.indices);
  skirtDepths.fill(outerDepth, baseCount, originalCount);
  skirtDepths.fill(depth, originalCount);
  let vertex = originalCount, index = data.indices.length;
  const inset = Math.max(1e-5, Math.abs(data.positions[3] - data.positions[0]) * 1e-5);

  const edge = (getIndex, axis, direction, flip) => {
    const first = vertex;
    for (let k = 0; k <= N; k++, vertex++) {
      const source = getIndex(k);
      positions.set(data.positions.subarray(source * 3, source * 3 + 3), vertex * 3);
      positions[vertex * 3 + 1] -= depth;
      // Leave top vertices exactly on the cut. A tiny inward lean assigns each
      // skirt's triangle centroids to its owner, including the negative halves.
      positions[vertex * 3 + axis] += direction * inset;
      normals.set(data.normals.subarray(source * 3, source * 3 + 3), vertex * 3);
      surface.set(data.surface.subarray(source * 4, source * 4 + 4), vertex * 4);
      roadDistances[vertex] = data.roadDistances[source];
      ecology.set(data.ecology.subarray(source * 2, source * 2 + 2), vertex * 2);
    }
    for (let k = 0; k < N; k++) {
      const a = getIndex(k), b = getIndex(k + 1), c = first + k, d = c + 1;
      if (flip) {
        indices[index++] = a; indices[index++] = b; indices[index++] = c;
        indices[index++] = b; indices[index++] = d; indices[index++] = c;
      } else {
        indices[index++] = a; indices[index++] = c; indices[index++] = b;
        indices[index++] = b; indices[index++] = c; indices[index++] = d;
      }
    }
  };
  edge((j) => j * stride + N / 2, 0, -1, true);
  edge((j) => j * stride + N / 2, 0, 1, false);
  edge((i) => N / 2 * stride + i, 2, -1, false);
  edge((i) => N / 2 * stride + i, 2, 1, true);
  return { ...data, positions, normals, surface, roadDistances, ecology, indices, skirtDepths };
}
