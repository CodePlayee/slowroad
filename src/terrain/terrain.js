// src/terrain/terrain.js — coverage-preserving terrain streaming.
// Coarse tiles stay resident; ready descendants replace individual quadrants.
// Worker builds, bounded publication, and protected caches keep loading off-screen.

import * as THREE from 'three';
import { TERRAIN as P } from './params.js';
import { clamp } from '../core/rng.js';
import { SURFACE_HASH_GLSL } from '../core/shaderNoise.js';
import { buildTerrainTileData, addQuadrantSkirts } from './mesh-data.js';
import { TerrainWorkerPool } from './worker-pool.js';
import { makeTile, parentTile, partitionIndices, selectCoverage } from './coverage.js';
import { GRASS_COVERAGE_GLSL } from '../vegetation/grassCoverage.js';
import { terrainResolution, nearRoadCorridorIntersects } from './surfaceSampler.js';
import { PlantContactTexture } from './plantContact.js';

const CONTACT_RECORDS_PER_FRAME = 2048;
// The current tree/shrub lattices admit <= 6908 candidates per snapped circle,
// before ecological rejection. Two disjoint active/target circles fit below this.
const CONTACT_MAX_RECORDS = 16384;

function contactIntersects(bounds, origin, field) {
  if (!bounds) return false;
  const x = origin.x + field.radius, z = origin.y + field.radius;
  const dx = x - clamp(x, bounds[0], bounds[2]), dz = z - clamp(z, bounds[1], bounds[3]);
  return dx * dx + dz * dz <= (field.radius - field.texelSize) ** 2;
}

function contactContains(record, origin, field) {
  const dx = record.x - origin.x - field.radius, dz = record.z - origin.y - field.radius;
  return dx * dx + dz * dz <= (field.radius - field.texelSize) ** 2;
}

const TERRAIN_VERT_HEAD = /* glsl */`
attribute vec4 aSurf;
attribute vec2 aEcology;
attribute float aRoadDist;
attribute float aParentHeight;
attribute vec3 aParentNormal;
attribute float aMorphStart;
uniform float uTerrainTime;
varying vec4 vSurf;
varying vec2 vEcology;
varying float vRoadDist;
varying vec3 vTerrainNormal;
varying vec3 vWPosT;
varying float vFarY;
uniform float uFarRidgeAmp;
uniform float uFarRidgeNear;
uniform float uFarRidgeFar;
`;
const TERRAIN_VERT_BODY = /* glsl */`
  float terrainMorph = clamp((uTerrainTime - aMorphStart) / ${P.morphSeconds.toFixed(3)}, 0.0, 1.0);
  transformed.y = mix(aParentHeight, transformed.y, terrainMorph);
  // Broad crest layers are a visual-only LOD detail.  They fade in with distance,
  // so the analytic field used by route, water, vegetation, and bridges is unchanged.
  vec3 farWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vec2 farUv = farWorld.xz;
  // Three long, skewed ridge trains add broad highland silhouettes to the far
  // clipmap rings without changing the sampled world height used by roads,
  // rivers, bridges, or streaming.  The nested sin() warp keeps the bands
  // organic instead of reading as a repeating corrugated strip.
  float crestA = 1.0 - abs( sin( dot( farUv, vec2( 0.00016, 0.000095 ) )
    + sin( farUv.x * 0.000047 ) * 1.7 + sin( farUv.y * 0.000031 ) * 0.8 ) );
  float crestB = 1.0 - abs( sin( dot( farUv, vec2( -0.000071, 0.00019 ) )
    + sin( farUv.y * 0.000061 ) * 1.4 + sin( farUv.x * 0.000022 ) * 0.9 ) );
  float crestC = 1.0 - abs( sin( dot( farUv, vec2( 0.00031, -0.00022 ) )
    + sin( dot( farUv, vec2( 0.00009, 0.00013 ) ) ) * 0.55 ) );
  // A very low-frequency contour keeps the three crest trains from reading as
  // parallel strips. It is evaluated in the vertex shader only, so no samples or
  // additional geometry are introduced.
  float contourA = 0.5 + 0.5 * sin( dot( farUv, vec2( 0.000043, -0.000027 ) )
    + sin( farUv.x * 0.000019 + farUv.y * 0.000013 ) * 1.2 );
  float contourB = 0.5 + 0.5 * cos( dot( farUv, vec2( -0.000021, 0.000036 ) )
    + sin( farUv.y * 0.000016 ) * 0.9 );
  float farShape = ( smoothstep( 0.16, 0.86, crestA ) * ( 0.38 + contourA * 0.18 )
    + smoothstep( 0.18, 0.84, crestB ) * ( 0.24 + contourB * 0.16 )
    + smoothstep( 0.22, 0.82, crestC ) * 0.18 ) - 0.34;
  float ridgeShoulder = smoothstep( 0.34, 0.72,
    crestA * ( 0.46 + contourA * 0.16 ) + crestB * ( 0.30 + contourB * 0.08 ) );
  float farFade = smoothstep( uFarRidgeNear, uFarRidgeFar,
    distance( farWorld.xz, cameraPosition.xz ) );
  transformed.y += ( farShape * uFarRidgeAmp
    + ( ridgeShoulder - 0.42 ) * uFarRidgeAmp * 0.34 ) * farFade;
  vSurf = aSurf;
  vEcology = aEcology;
  vRoadDist = aRoadDist;
  vTerrainNormal = normalize( mat3( modelMatrix ) * objectNormal );
  vWPosT = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vFarY = vWPosT.y;
`;
const TERRAIN_FRAG_HEAD = /* glsl */`
varying vec4 vSurf;
varying vec2 vEcology;
varying float vRoadDist;
varying vec3 vTerrainNormal;
varying vec3 vWPosT;
varying float vFarY;
uniform vec3 uGrassLush;
uniform vec3 uGrassDry;
uniform vec3 uRock;
uniform vec3 uSand;
uniform vec3 uSnow;
uniform vec3 uSoil;
uniform float uSnowAmount;
uniform float uSnowLine;
uniform float uLitterAutumn;
uniform float uRoadScuffInner;
uniform float uRoadScuffOuter;
uniform float uRoadContactDarken;
uniform float uTerrainLayerStrength;
uniform float uMeadowContactStrength;
uniform float uCanopyDirectTransmission;
uniform float uCanopyIndirectTransmission;
uniform float uCanopyWinterOcclusion;
uniform sampler2D uGrassDetail;
uniform sampler2D uForestDetail;
uniform sampler2D uPlantContact;
uniform vec2 uPlantContactOrigin;
uniform float uPlantContactSpan;
${GRASS_COVERAGE_GLSL}

${SURFACE_HASH_GLSL}
float thash( vec2 p ) { return surfaceHash(p); }
float tvn( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( thash( i ), thash( i + vec2( 1, 0 ) ), f.x ),
              mix( thash( i + vec2( 0, 1 ) ), thash( i + vec2( 1, 1 ) ), f.x ), f.y );
}
float tfbm( vec2 p ) {
  float s = 0.0, a = 0.5;
  for ( int i = 0; i < 4; i ++ ) { s += a * tvn( p ); p *= 2.07; a *= 0.5; }
  return s;
}
`;
const TERRAIN_FRAG_BODY = /* glsl */`
  float moist = vSurf.x;
  float rockA = vSurf.y;
  float shore = vSurf.z;
  float alt   = vSurf.w;
  float slope = clamp( 1.0 - vTerrainNormal.y, 0.0, 1.0 );

  // World-space layers avoid clipmap seams while keeping broad meadow patches
  // coherent from the road edge to the distant hills.
  vec2 uv = vWPosT.xz;
  float macro = tfbm( uv * 0.00135 );
  float meso  = tfbm( uv * 0.0085 + vec2( 13.7, -8.1 ) );
  float relief = tfbm( uv * 0.018 + vec2( -5.0, 17.0 ) );
  float micro = tvn( uv * 0.22 + vec2( 4.0, 9.0 ) );
  float canopy = clamp(vEcology.x, 0.0, 1.0);
  float clump = clamp(vEcology.y, 0.0, 1.0);
  float forestFloor = smoothstep(0.24, 0.76, canopy + (clump - 0.5) * 0.20 + (meso - 0.5) * 0.25);
  float understoryGrowth = smoothstep(0.18, 0.82, clump * 0.62 + moist * 0.28 + (1.0 - canopy) * 0.10);
  float mossShare = smoothstep(0.30, 0.82, moist) * (0.10 + 0.18 * (1.0 - clump));
  float litterShare = (0.32 + 0.42 * (1.0 - understoryGrowth)) * (1.0 - mossShare);

  float m = clamp( moist * 2.15 - 0.45 + ( macro - 0.5 ) * 0.80, 0.0, 1.0 );
  vec3 col = mix( uGrassDry, uGrassLush, m );
  // Broad rolling patches and a second, offset octave keep the same biome from
  // reading as one flat green sheet at clipmap boundaries.
  float patchTone = smoothstep( 0.34, 0.78, relief + ( 0.5 - moist ) * 0.24 );
  col = mix( col, mix( uGrassLush, uGrassDry, 0.42 ), patchTone * 0.24 );
  // The mesh normal carries a continuous slope signal across clipmap cells;
  // combining it with moisture makes broad soil bands instead of isolated tan
  // patches on the road verge.
  float slopeSoil = smoothstep( 0.18, 0.62, slope + ( meso - 0.5 ) * 0.18 );
  float rk = smoothstep( 0.26, 0.68, rockA + ( macro - 0.5 ) * 0.22 + ( relief - 0.5 ) * 0.12 + slope * 0.18 );
  // A continuous contour band ties material changes to the landform rather
  // than to clipmap cells.  It gives elevated shoulders a muted, rocky face
  // while preserving grass in hollows and meadow flats.
  float contour = smoothstep( 0.38, 0.76, macro * 0.72 + relief * 0.50 + slope * 0.30 );
  // Height bands are deliberately very broad: they read as continuous
  // contour material on ridges rather than isolated low-poly tan polygons.
  float upland = smoothstep( 150.0, 300.0, alt );
  float highland = smoothstep( 300.0, 560.0, alt ) * ( 1.0 - smoothstep( 0.78, 0.98, moist ) );
  float alpine = smoothstep( 500.0, 760.0, alt );
  float contourBand = clamp( contour * 0.68 + upland * 0.24 + highland * 0.30 + alpine * 0.12, 0.0, 1.0 );
  rk = clamp( rk + contourBand * 0.28, 0.0, 1.0 );
  // Exposed soil and leaf litter are more common in closed, damp stands and on
  // eroded slope breaks.  This is intentionally subtle at the horizon.
  float soil = smoothstep( 0.24, 0.62, meso + ( 0.5 - moist ) * 0.55 ) * ( 1.0 - rk * 0.58 );
  soil = clamp( soil + slopeSoil * ( 0.18 + 0.28 * ( 1.0 - moist ) ), 0.0, 1.0 );
  col = mix( col, uSoil * ( 0.76 + 0.42 * micro ), soil * 0.46 );
  col *= 0.82 + 0.34 * meso + 0.10 * relief;
  vec3 rockCol = uRock * ( 0.72 + 0.48 * tfbm( uv * 0.034 ) );
  // A muted upland belt sits between meadow and exposed rock.  This broad
  // transition is the key to eliminating the flat-sheet read in the vista.
  vec3 uplandCol = mix( uGrassDry * 0.82, uRock * 0.92, 0.34 + 0.26 * contour );
  col = mix( col, uplandCol, upland * ( 0.16 + 0.14 * contour ) );
  col = mix( col, rockCol, rk );

  col = mix( col, uSand * ( 0.88 + 0.24 * meso ), clamp( shore, 0.0, 1.0 ) );

  // A road-aware scuff layer is carried by the terrain vertices, so the edge
  // remains continuous when the road ribbon streams across clipmap chunks.
  // It is deliberately soil/grass biased rather than another pale tan band.
  // Perturb the daylight line in world space.  The same noise follows the road
  // across clipmap tiles, removing the straight, hard polygon edge while keeping
  // the transition coherent at the scale of tyre-worn ground.
  // Fine wear interrupts the boundary without widening it into a pale apron.
  float scuffNoise = mix(tvn(uv * 0.18 + vec2(21.0, -14.0)),
    tvn(uv * 1.60 + vec2(-3.0, 8.0)), 0.32);
  float roadEdge = vRoadDist + (scuffNoise - 0.5) * 1.15 + (micro - 0.5) * 0.30;
  float verge = 1.0 - smoothstep( uRoadScuffInner, uRoadScuffOuter, roadEdge );
  float shoulder = 1.0 - smoothstep(uRoadScuffInner - 0.20, uRoadScuffInner + 1.40, roadEdge);
  // Keep the graded shoulder close to the ground's darker soil value.  The
  // previous dry-grass endpoint became a broad, pale apron on coarse rings;
  // this endpoint remains biome-aware without introducing a second flat band.
  vec3 scuffBase = mix( uSoil * ( 0.66 + 0.28 * scuffNoise ), uGrassDry * 0.84,
    smoothstep( 0.22, 0.76, moist ) );
  // Preserve each terrain tile's macro/rock value under the scuff so the road
  // edge cannot become a separate tan band in the mid and far views.
  vec3 vergeCol = mix( col, scuffBase, 0.52 + 0.12 * scuffNoise );
  vergeCol = mix( vergeCol, uGrassLush, smoothstep( 0.60, 0.94, moist ) * 0.28 );
  col = mix( col, vergeCol, verge * uTerrainLayerStrength * 0.82 );
  // Small occlusion at the daylight line reads as contact with the road mesh,
  // while the distance fade prevents a dark halo in the open field.
  col *= 1.0 - shoulder * uRoadContactDarken * ( 0.68 + 0.32 * scuffNoise );

  // Low-frequency self-shadowing gives hillsides and damp pockets a continuous
  // value structure even when texture detail is disabled in the far field.
  float lay = tfbm( uv * 0.0042 + vec2( -31.0, 6.0 ) );
  float hollow = smoothstep( 0.22, 0.55, lay ) * ( 1.0 - smoothstep( 0.28, 0.70, slope ) );
  // A shallow, low-frequency contact term gives broad depressions and road
  // shoulders a grounded value without adding vertices or extra samples.
  float contact = smoothstep( 0.52, 0.90, 1.0 - slope ) * ( 0.55 + 0.45 * scuffNoise );
  col *= 1.0 - hollow * ( 0.06 + 0.12 * ( 1.0 - moist ) ) * uTerrainLayerStrength;
  col *= 1.0 - contact * 0.045 * uTerrainLayerStrength;
  // Both leaf reads keep the same physical scale. Adjacent random offsets
  // crossfade continuously; unshifted UV gradients prevent mip seams at swaps.
  vec2 detailUv = uv * 0.42 + vec2( 7.0, -5.0 );
  vec3 grassDetail = texture2D( uGrassDetail, detailUv ).rgb;
  vec2 litterUv = mat2(0.8, -0.6, 0.6, 0.8) * uv * 0.40 + vec2(3.1, -2.7);
  vec2 litterDx = dFdx(litterUv), litterDy = dFdy(litterUv);
  float litterVariation = tvn(uv * 0.045 + vec2(-7.0, 23.0));
  float litterPhase = litterVariation * 12.0;
  float litterIndex = floor(litterPhase);
  vec2 litterOffsetA = vec2(thash(vec2(litterIndex, 17.0)), thash(vec2(litterIndex, 43.0)));
  vec2 litterOffsetB = vec2(thash(vec2(litterIndex + 1.0, 17.0)), thash(vec2(litterIndex + 1.0, 43.0)));
  vec3 litterA = textureGrad(uForestDetail, litterUv + litterOffsetA, litterDx, litterDy).rgb;
  vec3 litterB = textureGrad(uForestDetail, litterUv + litterOffsetB, litterDx, litterDy).rgb;
  vec3 litterDetail = mix(litterA, litterB, smoothstep(0.20, 0.80, fract(litterPhase)));
  vec2 coarseGrassUv = mat2( 0.6, 0.8, -0.8, 0.6 ) * uv * 0.12
    + vec2( 19.7, -11.3 ) + vec2( meso, relief ) * 0.28;
  vec3 coarseGrassDetail = texture2D( uGrassDetail, coarseGrassUv ).rgb;
  float forestMix = clamp(forestFloor * 0.90 + soil * 0.10 + slope * 0.12, 0.0, 1.0);
  float textureValue = dot( mix( grassDetail, litterDetail, forestMix ),
    vec3( 0.2126, 0.7152, 0.0722 ) );
  float fineGrassValue = dot(grassDetail, vec3(0.2126, 0.7152, 0.0722));
  float coarseGrassValue = dot(coarseGrassDetail, vec3(0.2126, 0.7152, 0.0722));
  float fineLitterValue = dot(litterDetail, vec3(0.2126, 0.7152, 0.0722));
  float meadowSurface = (1.0 - smoothstep(0.20, 0.65, slope))
    * (1.0 - clamp(shore, 0.0, 1.0)) * (1.0 - rk)
    * (1.0 - clamp(uSnowAmount, 0.0, 1.0));
  float turfFray = smoothstep(0.055, 0.20, coarseGrassValue * 0.65 + fineGrassValue * 0.35);
  float meadowTexture = meadowSurface * (1.0 - verge * (1.0 - 0.38 * turfFray))
    * smoothstep(uRoadScuffInner - 0.15, uRoadScuffInner + 1.05, vRoadDist);
  float woodlandSurface = (1.0 - smoothstep(0.34, 0.78, slope))
    * (1.0 - clamp(shore, 0.0, 1.0)) * (1.0 - rk)
    * smoothstep(uRoadScuffInner - 0.15, uRoadScuffInner + 1.05, vRoadDist);
  vec2 plantContactUv = (uv - uPlantContactOrigin) / uPlantContactSpan;
  float plantContactBounds = step(0.0, plantContactUv.x) * step(plantContactUv.x, 1.0)
    * step(0.0, plantContactUv.y) * step(plantContactUv.y, 1.0);
  float plantContact = texture2D(uPlantContact, plantContactUv).r
    * plantContactBounds * woodlandSurface * (0.82 + 0.18 * micro);
  float rootSnowBank = smoothstep(0.02, 0.12, plantContact) * (1.0 - smoothstep(0.20, 0.44, plantContact));
  float rootSnowPocket = smoothstep(0.22, 0.50, plantContact);
  #if TERRAIN_SNOW
  float winterAmount = clamp(uSnowAmount, 0.0, 1.0);
  float winterGrassPatch = grassWinterExposure(vEcology.y) * grassRoadCoverage(vRoadDist);
  float winterThin = clamp(winterGrassPatch * 0.75 + smoothstep(0.28, 0.65, slope) * 0.55
    + rk * 0.55 + forestFloor * grassWinterExposure(vEcology.y) * 0.18, 0.0, 0.85);
  #else
  float winterAmount = 0.0;
  float winterThin = 0.0;
  #endif
  // Keep fine grain visible through the mid field while fading it gently into
  // atmospheric color; the procedural octave prevents a texture tile boundary
  // from becoming a new hard edge at the fade distance.
  // Keep the surface grain alive immediately beside the road. The old
  // 150 m fade-in left the near shoulder on a single procedural colour, which
  // made the road verge read as a hard stamped plane before the texture ever
  // appeared.  Fade it gradually through the mid field, then let the broad
  // procedural layers take over in the far rings.
  float detailWeight = 1.0 - smoothstep( 18.0, 1180.0, length( vViewPosition ) );
  float detailGrain = mix( 0.80 + 0.42 * micro, clamp( 0.38 + 2.72 * textureValue, 0.48, 1.52 ), 0.68 );
  float detailBlend = detailWeight * ( 0.70 + 0.30 * ( 1.0 - smoothstep( 620.0, 1680.0, length( vViewPosition ) ) ) );
  detailBlend *= mix(1.0, winterThin, winterAmount);
  // Both texture scales remain world-fixed. Luminance preserves blade/root
  // contrast while the seasonal palette supplies the turf's color.
  float fineGrassGrain = clamp(0.28 + 4.50 * fineGrassValue, 0.30, 1.60);
  float coarseGrassGrain = clamp(0.28 + 4.50 * coarseGrassValue, 0.30, 1.60);
  float turfGrain = mix(fineGrassGrain, coarseGrassGrain, 0.26);
  detailGrain = mix(detailGrain, turfGrain, meadowTexture * 0.86);
  vec3 meadowCol = mix(uGrassDry, uGrassLush, clamp(moist * 0.86 + 0.08, 0.0, 1.0))
    * 0.64 * (0.88 + 0.20 * meso + 0.12 * relief);
  col = mix(col, meadowCol, meadowTexture * 0.90);
  col *= mix(1.0, detailGrain, detailBlend);
  // Forest cover uses the same seeded ecology as the plants, not camera range.
  float moss = smoothstep(0.32, 0.76, moist * 0.48 + clump * 0.32 + meso * 0.20);
  // Keep the actual leaf/humus albedo: a luminance-only multiplier erased the
  // distinction between leaf surfaces, moss and the soil beneath them.
  float litterPatch = 0.90 + 0.20 * litterVariation;
  vec3 litterSeason = mix(vec3(0.82, 0.94, 0.79), vec3(1.05, 0.88, 0.64), uLitterAutumn);
  vec3 woodlandCol = litterDetail * litterSeason * litterPatch
    * mix(vec3(1.0), vec3(0.84, 0.96, 0.83), moss * 0.45);
  float litterExposure = mix(1.0, winterThin, winterAmount);
  woodlandCol = mix(uSoil * vec3(0.42, 0.42, 0.38), woodlandCol, litterExposure);
  float woodlandWeight = forestFloor * woodlandSurface;
  float litterWeight = woodlandWeight * litterShare;
  float mossWeight = woodlandWeight * mossShare;
  vec3 mossCol = mix(uGrassDry * vec3(0.60, 0.70, 0.48), uGrassLush * vec3(0.55, 0.63, 0.44),
    clamp(moist * 1.20, 0.0, 1.0));
  mossCol *= mix(1.0, 0.85 + 0.15 * coarseGrassGrain, litterExposure);
  // Blend after the background grain so partially wooded boundaries do not
  // multiply leaf albedo twice. The retained turf does not end at the model LOD.
  col = col * (1.0 - litterWeight - mossWeight) + woodlandCol * litterWeight + mossCol * mossWeight;

  // Turf keeps its root occlusion when models yield to texture-only ground.
  // Composition is world-fixed; only physical surface exclusions mask it out.
  float meadowContact = meadowSurface * (1.0 - litterWeight - mossWeight)
    * (0.35 + 0.65 * understoryGrowth)
    * smoothstep(uRoadScuffInner - 0.15, uRoadScuffInner + 1.05, vRoadDist);
  col *= 1.0 - meadowContact * uMeadowContactStrength * (0.82 + 0.18 * meso);

  // Snow is a continuous field, but not a flat white decal.  Keep the broad
  // shelf on gentle ground while letting steep rock faces and road contact
  // show through.  All variation is world-space, so clipmap tiles share the
  // same drifts; turf and litter grain survive only in local thin-snow pockets.
  #if TERRAIN_SNOW
  float snowHeight = smoothstep( uSnowLine - 110.0, uSnowLine + 150.0, alt );
  float snowShelf = 1.0 - smoothstep( 0.26, 0.90, slope );
  float snowDrift = clamp( 0.70 + ( macro - 0.5 ) * 0.30
    + ( meso - 0.5 ) * 0.24 + ( relief - 0.5 ) * 0.16, 0.34, 1.0 );
  float snowMounds = tvn(uv * 0.18 + vec2(relief, meso) * 2.0);
  float snowCrust = tvn(mat2(0.8, -0.6, 0.6, 0.8) * uv * vec2(1.1, 0.3) + vec2(17.0, -4.0));
  float snowReliefWeight = 1.0 - smoothstep(65.0, 220.0, length(vViewPosition));
  float snowAccumulation = mix(0.5, smoothstep(0.26, 0.74, snowMounds * 0.68 + snowCrust * 0.32), snowReliefWeight);
  snowAccumulation = clamp(snowAccumulation + rootSnowBank * 0.10 - rootSnowPocket * 0.08, 0.0, 1.0);
  float snow = uSnowAmount * ( 0.20 + 0.72 * snowHeight ) * snowShelf * snowDrift;
  // Rounded accumulations bury the turf; compressed pockets retain a dark base.
  snow *= mix(0.66, 1.20, snowAccumulation);
  snow = max(snow, uSnowAmount * snowShelf * (0.78 + 0.12 * snowAccumulation - 0.50 * winterThin));
  snow *= 1.0 - rk * 0.56;
  snow *= 1.0 - verge * ( 0.18 + 0.10 * scuffNoise );
  snow *= step( 0.001, uSnowAmount );
  snow += winterAmount * snowShelf * (rootSnowBank * 0.035 - rootSnowPocket * 0.07);
  snow = clamp(snow, 0.0, 1.0);
  float snowGrain = clamp(0.88 + 0.06 * snowMounds + 0.04 * snowCrust
    + 0.04 * meso + 0.025 * relief, 0.86, 1.06);
  vec2 snowGrainUv = mat2(0.8, -0.6, 0.6, 0.8) * uv * 18.0;
  float snowGrainFootprint = max(length(dFdx(snowGrainUv)), length(dFdy(snowGrainUv)));
  float snowFine = (tvn(snowGrainUv + vec2(71.0, -29.0)) - 0.5)
    * (1.0 - smoothstep(0.35, 1.15, snowGrainFootprint));
  vec3 snowCol = uSnow * (0.78 + 0.08 * snowAccumulation + 0.08 * snowGrain);
  vec3 packedSnow = uSnow * vec3(0.76, 0.80, 0.85) * (0.92 + 0.06 * snowGrain);
  snowCol = mix(packedSnow, snowCol, smoothstep(0.20, 0.75, snowAccumulation));
  // Wind-packed shade on steep faces remains separate from the smooth snow cap.
  snowCol = mix( snowCol, uSnow * vec3( 0.76, 0.82, 0.92 ),
    smoothstep( 0.28, 0.82, slope ) * 0.34 );
  snowCol *= 1.0 + snowFine * 0.055 * (0.55 + 0.45 * snowAccumulation);
  col = mix( col, snowCol, snow );
  #else
  float snow = 0.0, snowMounds = 0.0, snowCrust = 0.0, snowFine = 0.0;
  #endif

  // Meter-scale snow relief and shallow turf roots alter lighting, not geometry.
  float surfaceReliefFade = 1.0 - smoothstep(40.0, 150.0, length(vViewPosition));
  float turfMicroHeight = (fineGrassValue * 0.006 + coarseGrassValue * 0.012)
    * (1.0 - rk) * (1.0 - clamp(shore, 0.0, 1.0));
  turfMicroHeight = turfMicroHeight * (1.0 - litterWeight - mossWeight)
    + fineLitterValue * 0.025 * litterWeight + coarseGrassValue * 0.006 * mossWeight;
  turfMicroHeight *= mix(1.0, winterThin, winterAmount);
  float terrainMicroHeight = mix(turfMicroHeight, snowMounds * 0.025 + snowCrust * 0.003, snow)
    * surfaceReliefFade;
  terrainMicroHeight += snowFine * 0.0006 * snow * surfaceReliefFade;
  terrainMicroHeight += (rootSnowBank * 0.012 - rootSnowPocket * 0.004) * winterAmount * surfaceReliefFade;

  col *= mix(0.86 + 0.26 * micro + 0.08 * relief, 0.97 + 0.04 * meso + 0.025 * relief, snow);
  // Separate distant terrain into broad, atmospheric ridge values.  This is a
  // material-only fade, so the existing LOD mesh, route and streaming budgets
  // remain untouched while far landforms stop reading as one pale sheet.
  float terrainDistance = distance( vWPosT.xz, cameraPosition.xz );
  float nearLayer = smoothstep( 380.0, 920.0, terrainDistance );
  float farLayer = smoothstep( 700.0, 2550.0, terrainDistance );
  float horizonLayer = smoothstep( 1750.0, 5200.0, terrainDistance );
  // Distinct low-frequency contour bands create a readable succession of
  // shoulder / middle ridge / horizon ridge values even when the clipmap is
  // viewed from above. They are material-only and continuous across tiles.
  float farContour = tfbm( uv * 0.00072 + vec2( 27.0, -18.0 ) );
  // Use the displaced height for distant material bands; CPU terrain height is
  // intentionally unchanged, so this keeps crest highlights aligned with the
  // shader-only silhouette lift.
  float farAlt = smoothstep( 120.0, 560.0, vFarY );
  float ridgeLow = smoothstep( 0.24, 0.74, macro * 0.62 + relief * 0.28 + farContour * 0.44 + farAlt * 0.12 );
  float ridgeMid = smoothstep( 0.34, 0.78, macro * 0.34 + relief * 0.54 + farContour * 0.38 + highland * 0.22 + farAlt * 0.16 );
  float ridgeHigh = smoothstep( 0.40, 0.82, macro * 0.26 + farContour * 0.32 + highland * 0.58 + alpine * 0.24 + farAlt * 0.18 );
  float farBand = smoothstep( 0.28, 0.78, macro * 0.75 + relief * 0.35 + highland * 0.35 );
  vec3 shoulderCol = mix( uGrassDry * 0.78, uRock * 0.86, 0.26 + 0.28 * ridgeLow );
  vec3 middleCol = mix( vec3( 0.20, 0.31, 0.30 ), vec3( 0.24, 0.34, 0.35 ), ridgeMid );
  vec3 horizonCol = mix( vec3( 0.16, 0.25, 0.31 ), vec3( 0.20, 0.30, 0.36 ), ridgeHigh );
  vec3 farBase = mix( vec3( 0.18, 0.27, 0.24 ), shoulderCol, 0.34 + farAlt * 0.42 );
  farBase = mix( farBase, middleCol, smoothstep( 0.16, 0.62, ridgeMid ) * 0.56 );
  farBase = mix( farBase, horizonCol, horizonLayer * ( 0.46 + 0.30 * ridgeHigh ) );
  // Let the far terrain lose chroma into the same blue-gray aerial veil as the
  // fog, rather than becoming a saturated blue strip below the horizon.
  float farDesat = smoothstep( 600.0, 1800.0, terrainDistance );
  float farLum = dot( farBase, vec3( 0.2126, 0.7152, 0.0722 ) );
  farBase = mix( farBase, vec3( farLum * 0.96 ), farDesat * 0.18 );
  // Low river/valley values pick up a quiet blue-green cast at range. This is
  // intentionally tied to the existing shore field, avoiding any fake water
  // geometry while helping distant real water survive the aerial wash.
  float waterHint = smoothstep( 0.04, 0.52, shore ) * smoothstep( 680.0, 2300.0, terrainDistance );
  farBase = mix( farBase, vec3( 0.12, 0.28, 0.31 ), waterHint * 0.24 );
  // Layered distance washes preserve a little local value in the near field,
  // then converge progressively toward cool atmospheric ridge colours.
  vec3 midBase = mix( col, shoulderCol, 0.30 + 0.15 * ridgeLow );
  col = mix( col, midBase, nearLayer * 0.20 );
  col = mix( col, farBase, farLayer * ( 0.42 + 0.14 * ridgeMid ) );
  col = mix( col, horizonCol, horizonLayer * 0.22 );
  float landLight = smoothstep( 0.28, 0.76,
    tfbm( uv * 0.00042 + vec2( -9.0, 13.0 ) ) * 0.62 + farAlt * 0.38 );
  col *= mix( 0.88, 1.07, landLight ) * ( 1.0 - farLayer * 0.06 * ( 1.0 - ridgeMid ) );

  // Winter is a continuous snow surface, not a white decal on selected tiles.
  // Re-apply a restrained snow field after the distance ridge pass so far terrain
  // keeps the same cool ground language while broad slope/rock variation survives.
  // uSnowAmount is zero for every other season, so this branch is inert there.
  #if TERRAIN_SNOW
  float winterSeason = step( 0.5, uSnowAmount );
  float winterDistance = smoothstep( 260.0, 2600.0, terrainDistance );
  float snowRelief = clamp( 0.38 + ( 1.0 - slope ) * 0.28
    + macro * 0.16 + relief * 0.12 + 0.18 * snowGrain - rk * 0.16,
    0.20, 0.96 );
  vec3 winterSnow = mix(
    vec3( 0.34, 0.39, 0.42 ),
    vec3( 0.72, 0.78, 0.81 ),
    snowRelief );
  winterSnow *= 0.86 + 0.22 * snowGrain;
  float winterCoverage = winterSeason * ( 0.16 + 0.12 * winterDistance ) *
    ( 1.0 - rk * 0.38 ) * ( 1.0 - slope * 0.20 ) * (1.0 - 0.45 * snowReliefWeight);
  col = mix( col, winterSnow, winterCoverage );
  // Keep a low-frequency value cue on the snow itself; it reads as rolling
  // relief in the far field instead of a featureless white plane.
  float winterReliefLight = mix( 0.90, 1.07,
    0.36 * macro + 0.34 * relief + 0.20 * snowGrain + 0.10 * ( 1.0 - slope ) );
  col *= mix( 1.0, winterReliefLight, winterSeason );
  // Re-introduce a restrained contact shadow after the distant winter pass;
  // otherwise the broad snow wash erases the dark, naturally graded road seam.
  col *= 1.0 - winterSeason * shoulder * uRoadContactDarken
    * ( 0.34 + 0.16 * scuffNoise );
  #endif
  diffuseColor.rgb *= col;
`;

const TERRAIN_NORMAL_BODY = /* glsl */`
  vec3 terrainDx = dFdx(-vViewPosition), terrainDy = dFdy(-vViewPosition);
  vec3 terrainR1 = cross(terrainDy, normal), terrainR2 = cross(normal, terrainDx);
  float terrainDet = dot(terrainDx, terrainR1) * faceDirection;
  vec3 terrainGradient = sign(terrainDet) *
    (dFdx(terrainMicroHeight) * terrainR1 + dFdy(terrainMicroHeight) * terrainR2);
  normal = normalize(max(abs(terrainDet), 0.000001) * normal - terrainGradient);
`;

const TERRAIN_LIGHT_BODY = /* glsl */`
  // Local canopy transmission leaves open ground and excluded surfaces alone.
  float canopyOcclusion = woodlandWeight * (0.78 + 0.22 * smoothstep(0.24, 0.76, canopy * 0.68 + meso * 0.32))
    * mix(1.0, uCanopyWinterOcclusion, winterAmount);
  reflectedLight.directDiffuse *= mix(1.0, uCanopyDirectTransmission, canopyOcclusion);
  reflectedLight.indirectDiffuse *= mix(1.0, uCanopyIndirectTransmission, canopyOcclusion);
  reflectedLight.directDiffuse *= 1.0 - plantContact * mix(0.22, 0.10, winterAmount);
  reflectedLight.indirectDiffuse *= 1.0 - plantContact * mix(0.30, 0.14, winterAmount);
`;

export class Terrain {
  constructor(world, atmo, scheduler, waterSystem) {
    this.world = world;
    this.atmo = atmo;
    this.scheduler = scheduler;
    this.water = waterSystem;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.waterGroup = new THREE.Group();
    this.waterGroup.name = 'water';
    this.chunks = new Map();
    this.renderSet = new Map();
    this.regions = [];
    this.roots = [];
    this.requests = new Map();
    this.jobs = new Map();
    this.coverageRevision = 0;
    this._selectionDirty = true;
    this._lastUploadFrame = -1;
    this._uploadCount = 0;
    this._frame = 0;
    this._latencies = [];
    this.workerFallbacks = 0;
    this.workerPool = new TerrainWorkerPool();
    this.workerPool.reset(world);
    this._requiredCache = null;
    this._requiredWant = null;
    this._anchor = null;
    this._lastRequired = null;
    this.version = 0;
    this.plantContact = new PlantContactTexture({ maxRecords: CONTACT_MAX_RECORDS });
    this.plantContact.texture.onUpdate = () => this.plantContact.markClean();
    this._plantContactEnabled = false;
    this._plantContactDirty = true;
    this._plantContactRevision = 0;
    this._plantContactFrame = -1;
    this._plantContactTarget = new THREE.Vector2(NaN, NaN);
    this._plantContactSelection = null;
    this._plantContactActiveTiles = new Set();
    this._plantContactPendingTiles = null;
    this._plantContactWork = { tilesVisited: 0, recordsVisited: 0, preparationRecords: 0, rasterChecks: 0 };

    this.fallbackTexture = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    this.fallbackTexture.colorSpace = THREE.SRGBColorSpace;
    this.fallbackTexture.needsUpdate = true;

    this.uniforms = {
      uGrassLush: { value: new THREE.Color(0.29, 0.47, 0.16) },
      uGrassDry: { value: new THREE.Color(0.63, 0.62, 0.29) },
      uRock: { value: new THREE.Color(0.50, 0.47, 0.42) },
      uSand: { value: new THREE.Color(0.68, 0.62, 0.47) },
      uSoil: { value: new THREE.Color(0.30, 0.24, 0.16) },
      uSnow: { value: new THREE.Color(0.92, 0.94, 0.98) },
      uSnowAmount: { value: 0 },
      uSnowLine: { value: 900 },
      uLitterAutumn: { value: 0 },
      uRoadScuffInner: { value: P.roadScuffInner },
      uRoadScuffOuter: { value: P.roadScuffOuter },
      uRoadContactDarken: { value: P.roadContactDarken },
      uTerrainLayerStrength: { value: P.terrainLayerStrength },
      uMeadowContactStrength: { value: 0.26 },
      uCanopyDirectTransmission: { value: 0.44 },
      uCanopyIndirectTransmission: { value: 0.72 },
      uCanopyWinterOcclusion: { value: 0.38 },
      uFarRidgeAmp: { value: P.farRidgeAmp },
      uFarRidgeNear: { value: P.farRidgeNear },
      uFarRidgeFar: { value: P.farRidgeFar },
      uGrassDetail: { value: this.fallbackTexture },
      uForestDetail: { value: this.fallbackTexture },
      uPlantContact: { value: this.plantContact.texture },
      uPlantContactOrigin: { value: this.plantContact.origin },
      uPlantContactSpan: { value: this.plantContact.span },
      uTerrainTime: { value: performance.now() / 1000 },
    };
    this.assetError = null;
    const loader = new THREE.TextureLoader();
    this.assetPromise = Promise.all([
      loader.loadAsync('/textures/meadow-turf-v1.png'),
      loader.loadAsync('/textures/woodland-litter-v1.png'),
    ]).then(([grass, forest]) => {
      for (const texture of [grass, forest]) {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = Math.min(8, atmo.renderer.capabilities.getMaxAnisotropy());
      }
      this.uniforms.uGrassDetail.value = grass;
      this.uniforms.uForestDetail.value = forest;
      atmo.renderer.initTexture?.(grass);
      atmo.renderer.initTexture?.(forest);
    }).catch((error) => { this.assetError = String(error.message || error); });

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.96, metalness: 0.0, dithering: true,
    });
    this.material.name = 'terrain';
    const U = this.uniforms;
    this.material.onBeforeCompile = (shader) => {
      for (const k in U) shader.uniforms[k] = U[k];
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + TERRAIN_VERT_HEAD)
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' +
          `objectNormal = normalize(mix(aParentNormal, objectNormal, clamp((uTerrainTime - aMorphStart) / ${P.morphSeconds.toFixed(3)}, 0.0, 1.0)));`)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + TERRAIN_VERT_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + TERRAIN_FRAG_HEAD)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + TERRAIN_FRAG_BODY)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.82 + 0.14 * (1.0 - smoothstep(0.03, 0.20, fineLitterValue)),
            litterWeight * (1.0 - snow) * litterExposure);`)
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + TERRAIN_NORMAL_BODY)
        .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + TERRAIN_LIGHT_BODY);
    };
    this.material.customProgramCacheKey = () => 'terrain-season-specialized-v13';
    atmo.register(this.material);
    this.applyPalette();
  }

  applyPalette() {
    const p = this.atmo.palette;
    const snow = p.snowAmount > 0 ? 1 : 0;
    if (this.material && this.material.defines?.TERRAIN_SNOW !== snow) {
      this.material.defines = { ...this.material.defines, TERRAIN_SNOW: snow };
      this.material.needsUpdate = true;
    }
    const U = this.uniforms;
    U.uGrassLush.value.setRGB(...p.grassLush);
    U.uGrassDry.value.setRGB(...p.grassDry);
    U.uRock.value.setRGB(...p.rock);
    U.uSand.value.setRGB(...p.sand);
    U.uSnowAmount.value = p.snowAmount;
    U.uSnowLine.value = p.snowLine;
    U.uLitterAutumn.value = this.atmo.seasonName === 'autumn' ? 1 : 0;
  }

  get plantContactReady() {
    return !this._plantContactEnabled || (!this._plantContactDirty && !this._plantContactSelection && !this.plantContact.pending);
  }

  plantContactStats() {
    return { ready: this.plantContactReady, pending: !this.plantContactReady,
      selecting: Boolean(this._plantContactSelection), records: this.plantContact.activeCount,
      version: this.plantContact.version, generation: this.plantContact.generation,
      lastWork: { ...this._plantContactWork } };
  }

  plantContactChanged(entry, removed = false, { reason, focus } = {}) {
    const field = this.plantContact, job = entry.job;
    if (field.disposed || !['tree', 'shrub'].includes(job?.kind)) return;
    if (!contactIntersects(job.groundBounds, field.origin, field)
      && !contactIntersects(job.groundBounds, this._plantContactTarget, field)) return;
    this._plantContactRevision++;
    this._plantContactDirty = true;
    this._plantContactSelection = null;
    if (removed) {
      field.cancelPending();
      this._plantContactPendingTiles = null;
      if (this._plantContactActiveTiles.has(job.key)) {
        const stillEffective = reason !== 'stream-eviction' || !focus
          || field.retireOutsideWindow(entry.records, focus);
        if (stillEffective) {
          field.reset();
          this._plantContactActiveTiles.clear();
        } else this._plantContactActiveTiles.delete(job.key);
      }
    }
  }

  resetPlantContact() {
    if (this.plantContact.disposed) return;
    this.plantContact.reset();
    this._plantContactDirty = true;
    this._plantContactRevision++;
    this._plantContactSelection = this._plantContactPendingTiles = null;
    this._plantContactActiveTiles.clear();
    this._plantContactTarget.set(NaN, NaN);
    this._plantContactFrame = -1;
  }

  updatePlantContact(tiles, x, z) {
    const field = this.plantContact;
    if (field.disposed || this._plantContactFrame === this._frame) return;
    this._plantContactFrame = this._frame;
    this._plantContactEnabled = true;
    const work = this._plantContactWork = { tilesVisited: 0, recordsVisited: 0, preparationRecords: 0, rasterChecks: 0 };
    const target = field.originForFocus({ x, z });
    if (!target.equals(this._plantContactTarget)) {
      field.cancelPending();
      this._plantContactPendingTiles = null;
      this._plantContactTarget.copy(target);
      this._plantContactDirty = true;
      this._plantContactSelection = null;
    }
    if (this._plantContactDirty) {
      const windows = [target];
      if (field.activeCount && !target.equals(field.origin)) windows.push(field.origin.clone());
      const entries = [];
      // Inspect tile bounds only. Far records and all grass arrays stay untouched.
      for (const entry of tiles.values()) {
        work.tilesVisited++;
        if (entry.groundReady && ['tree', 'shrub'].includes(entry.job.kind)
          && windows.some(origin => contactIntersects(entry.job.groundBounds, origin, field))) entries.push(entry);
      }
      this._plantContactSelection = { entries, windows, target, focus: { x, z }, entry: 0, record: 0,
        records: [], targetTiles: new Set() };
      this._plantContactDirty = false;
    }
    const selection = this._plantContactSelection;
    if (selection) {
      while (selection.entry < selection.entries.length && work.recordsVisited < CONTACT_RECORDS_PER_FRAME) {
        const entry = selection.entries[selection.entry];
        if (selection.record >= entry.records.length) { selection.entry++; selection.record = 0; continue; }
        const record = entry.records[selection.record++];
        work.recordsVisited++;
        if (!['tree', 'shrub'].includes(record.kind) || !Number.isFinite(record.x) || !Number.isFinite(record.z)
          || !Number.isFinite(record.width) || record.width <= 0) continue;
        const inTarget = contactContains(record, selection.target, field);
        if (!inTarget && !selection.windows.some(origin => contactContains(record, origin, field))) continue;
        if (selection.records.length >= field.maxRecords) throw new RangeError('Near-field plant contact exceeds its candidate bound');
        selection.records.push(record);
        if (inTarget) selection.targetTiles.add(entry.job.key);
      }
      if (selection.entry === selection.entries.length) {
        field.update(selection.records, selection.focus, { revision: this._plantContactRevision });
        work.preparationRecords = field.lastUpdate.recordsVisited + field.lastUpdate.stampCandidates;
        this._plantContactSelection = null;
        if (field.pending) this._plantContactPendingTiles = { generation: field.generation, keys: selection.targetTiles };
        else { this._plantContactActiveTiles = selection.targetTiles; this._plantContactPendingTiles = null; }
      }
    }
    if (field.pending) {
      field.step();
      work.rasterChecks = field.lastStep.texelsVisited;
      if (!field.pending && this._plantContactPendingTiles?.generation === field.generation) {
        this._plantContactActiveTiles = this._plantContactPendingTiles.keys;
        this._plantContactPendingTiles = null;
      }
    }
  }

  /** Drop every chunk (seed change). */
  rebuildAll() {
    this.resetPlantContact();
    this.version++;
    for (const [, c] of this.chunks) this._dispose(c);
    this.chunks.clear();
    this.renderSet.clear();
    this.regions.length = 0;
    this.roots.length = 0;
    this.requests.clear();
    this.jobs.clear();
    this.workerPool.reset(this.world);
    this.coverageRevision++;
    this._selectionDirty = true;
    this._requiredCache = null;
    this._requiredWant = null;
    this._anchor = null;
    this._lastRequired = null;
    this.scheduler.drop((k) => k.startsWith('terr:'));
  }

  _dispose(c) {
    if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); }
    if (c.waterMesh) { this.waterGroup.remove(c.waterMesh); c.waterMesh.geometry.dispose(); }
  }

  _trimCache(now) {
    let bytes = 0;
    const candidates = [];
    for (const [key, c] of this.chunks) {
      bytes += c.bytes;
      if (!this.requests.has(key) && !this.renderSet.has(key)) candidates.push(c);
    }
    candidates.sort((a, b) => a.lastUsed - b.lastUsed);
    let freed = 0;
    for (const c of candidates) {
      if (freed >= 2) break;
      if (this.chunks.size <= P.cacheTiles && bytes <= P.cacheBytes && now - c.lastUsed < P.cacheSeconds) break;
      this._dispose(c);
      this.chunks.delete(c.tile.key);
      bytes -= c.bytes;
      freed++;
    }
    this.cachedBytes = bytes;
  }

  levelSize(l) { return P.chunkSize * Math.pow(2, l); }
  levelRes(l) { return P.resByLevel[Math.min(l, P.resByLevel.length - 1)]; }

  /** Keep parents resident; only the render selection may cut holes in them. */
  requiredSet(camX, camZ, ahead = { x: camX, z: camZ }) {
    const anchor = [];
    for (let l = 0; l < P.levels; l++) {
      const C = this.levelSize(l);
      anchor.push(Math.floor(camX / C), Math.floor(camZ / C), Math.floor(ahead.x / C), Math.floor(ahead.z / C));
    }
    const signature = anchor.join(',');
    if (signature === this._anchor && this._requiredCache) return this._requiredCache;
    this._anchor = signature;
    const wanted = new Map();
    const add = (tile, prefetch) => {
      if (wanted.has(tile.key) && !wanted.get(tile.key).prefetch) return;
      tile.prefetch = prefetch;
      tile.d = Math.hypot(tile.x0 + tile.C / 2 - camX, tile.z0 + tile.C / 2 - camZ);
      const near = tile.x0 < camX + 96 && tile.x0 + tile.C > camX - 96 &&
        tile.z0 < camZ + 96 && tile.z0 + tile.C > camZ - 96;
      const category = tile.l === P.levels - 1 ? -40000 : prefetch ? 50000 : near ? -30000 : -20000;
      tile.priority = category + (P.levels - 1 - tile.l) * 1000 + tile.d * 0.01;
      wanted.set(tile.key, tile);
    };
    for (const [x, z, prefetch] of [[ahead.x, ahead.z, true], [camX, camZ, false]]) {
      for (let l = 0; l < P.levels; l++) {
        const C = this.levelSize(l), ci = Math.floor(x / C), cj = Math.floor(z / C);
        // Tree tile corners need more than the default 2 * 512 m guard band.
        const R = l === P.levels - 1 ? P.coverageRadius : l === 2 ? 3 : P.ringRadius;
        for (let j = cj - R; j <= cj + R; j++) for (let i = ci - R; i <= ci + R; i++) {
          let tile = makeTile(this.version, l, i, j, P.chunkSize);
          add(tile, prefetch);
          while (tile.l < P.levels - 1) { tile = parentTile(tile); add(tile, prefetch); }
        }
      }
    }
    const out = [...wanted.values()].sort((a, b) => a.priority - b.priority);
    this._requiredCache = out;
    this._requiredWant = new Set(wanted.keys());
    this.requests = wanted;
    this.roots = out.filter(r => r.l === P.levels - 1);
    return out;
  }

  update(camX, camZ, ahead) {
    this.focusX = camX; this.focusZ = camZ;
    const now = performance.now() / 1000;
    this.uniforms.uTerrainTime.value = now;
    const req = this.requiredSet(camX, camZ, ahead);
    const want = this._requiredWant;
    const changed = req !== this._lastRequired;
    if (changed) {
      this.scheduler.drop((k) => k.startsWith('terr:') && !want.has(k));
      this.workerPool.cancelExcept(want);
      for (const key of this.jobs.keys()) if (!want.has(key)) this.jobs.delete(key);
      this._lastRequired = req;
      this._selectionDirty = true;
    }
    this.required = req.length;
    if (this._lastUploadFrame !== this._frame) {
      this._lastUploadFrame = this._frame;
      this._uploadCount = 0;
    }
    for (const r of req) {
      const cached = this.chunks.get(r.key);
      if (cached) { cached.lastUsed = now; continue; }
      if (this.scheduler.has(r.key)) continue;
      if (this.workerPool.has(r.key)) {
        if (this._uploadCount >= P.uploadTilesPerFrame) continue;
        const result = this.workerPool.poll(r.key);
        if (!result) continue;
        if (result.data) {
          this._uploadCount++;
          this.scheduler.push(r.key, r.priority, () => {
            if (this.requests.has(r.key)) this._publish(r, result.data);
          });
          continue;
        }
        // A failed worker must reduce throughput, not remove existing coverage.
        this.workerFallbacks++;
        this.scheduler.push(r.key, r.priority, this._buildTask(r));
        continue;
      }
      this.jobs.set(r.key, { queued: performance.now() });
      const options = this._buildOptions(r);
      if (!this.workerPool.request(r.key, r, options, r.priority)) {
        this.scheduler.push(r.key, r.priority, this._buildTask(r, options));
      }
    }
    this.refreshCoverage();
    this._trimCache(now);
  }

  get resident() {
    let count = 0;
    for (const key of this.requests.keys()) if (this.chunks.has(key)) count++;
    return count;
  }

  get pending() { return Math.max(0, this.required - this.resident); }

  get settled() {
    if (!this.plantContactReady) return false;
    const now = this.uniforms.uTerrainTime.value;
    for (const key of this.renderSet.keys()) if (this.chunks.get(key).morphEnd > now) return false;
    return true;
  }

  get coverageReady() {
    return this.roots.length > 0 && this.roots.every(r => this.chunks.has(r.key)) &&
      this.coversBounds(this.focusX - 96, this.focusZ - 96, this.focusX + 96, this.focusZ + 96, 0);
  }

  get prefetchSeconds() {
    const samples = this._latencies.slice().sort((a, b) => a - b);
    return clamp((samples[Math.floor(samples.length * 0.95)] || 1000) / 1000 + 0.75, 1.5, 6);
  }

  _buildOptions(r) {
    return { resolution: this._resolution(r), skirtDepth: P.skirtDepth,
      ...(this.water && r.l <= 4 ? { waterResolution: this.levelRes(r.l) } : {}) };
  }

  _buildTask(r, options = this._buildOptions(r)) {
    const iterator = buildTerrainTileData(this.world, r, options);
    const advance = () => {
      if (!this.requests.has(r.key)) return;
      const step = iterator.next();
      if (!step.done) return advance;
      this._publish(r, step.value);
    };
    return advance;
  }

  _resolution(r) {
    const config = this.world.surfaceConfig ?? P;
    return terrainResolution(r.l, r.C, r.l < config.nearRoadLevels && this._roadCorridorIntersects(r), config);
  }

  refreshCoverage() {
    const now = performance.now() / 1000;
    this.uniforms.uTerrainTime.value = now;
    let morphFinished = false;
    for (const c of this.chunks.values()) {
      if (!c.settled && now >= c.morphEnd) { c.settled = true; morphFinished = true; }
    }
    if (!this._selectionDirty && !morphFinished) return;
    const ready = new Map([...this.chunks].filter(([, c]) => {
      const parent = this.chunks.get(parentTile(c.tile).key);
      return !parent || parent.settled;
    }));
    const selected = selectCoverage(this.roots, ready, this._requiredWant || new Set());
    const applyMask = (mesh, mask) => {
      if (!mesh) return;
      mesh.visible = mask !== 0;
      mesh.geometry.clearGroups();
      let start = 0, count = 0;
      for (let q = 0; q <= 4; q++) {
        const r = mesh.userData.quadrants[q];
        if (q < 4 && (mask & (1 << q))) {
          if (!count) start = r.start;
          count += r.count;
        } else if (count) {
          mesh.geometry.addGroup(start, count, 0);
          count = 0;
        }
      }
    };
    for (const [key, c] of this.chunks) {
      const mask = selected.get(key) || 0;
      if (mask !== c.mask) {
        if (mask && !c.revealed) this._prepareMorph(c, now);
        applyMask(c.mesh, mask); applyMask(c.waterMesh, mask); c.mask = mask;
      }
    }
    this.renderSet = selected;
    this.regions = [];
    for (const [key, mask] of selected) {
      const c = this.chunks.get(key), t = c.tile, half = t.C / 2;
      c.lastUsed = now;
      for (let q = 0; q < 4; q++) if (mask & (1 << q)) {
        this.regions.push({ key, l: t.l, settled: c.settled, sourceLevel: c.morphFromLevel ?? t.l,
          x0: t.x0 + (q & 1) * half, z0: t.z0 + (q >> 1) * half, C: half });
      }
    }
    this.coverageRevision++;
    this._selectionDirty = false;
  }

  coversBounds(x0, z0, x1, z1, maxLevel = Infinity) {
    const requiredArea = (x1 - x0) * (z1 - z0);
    if (requiredArea <= 0) return false;
    let area = 0;
    for (const r of this.regions) {
      if ((r.settled ? r.l : Math.max(r.l, r.sourceLevel)) > maxLevel) continue;
      area += Math.max(0, Math.min(x1, r.x0 + r.C) - Math.max(x0, r.x0)) *
        Math.max(0, Math.min(z1, r.z0 + r.C) - Math.max(z0, r.z0));
    }
    return area >= requiredArea - Math.max(1e-5, requiredArea * 1e-9);
  }

  /**
   * Return true when the road corridor can touch a tile. A centre-only query
   * can miss a route that clips an edge or corner, so probe all five points.
   * The diagonal reach is conservative, while keeping refinement bounded to
   * this tile plus the configured shoulder margin.
   */
  _roadCorridorIntersects(r) {
    return nearRoadCorridorIntersects(this.world, r);
  }

  _mesh(data, material, tile) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('aSurf', new THREE.BufferAttribute(data.surface, 4));
    geometry.setAttribute('aEcology', new THREE.BufferAttribute(data.ecology, 2));
    geometry.setAttribute('aRoadDist', new THREE.BufferAttribute(data.roadDistances, 1));
    const n = data.positions.length / 3;
    const parentHeight = new Float32Array(n);
    for (let i = 0; i < n; i++) parentHeight[i] = data.positions[i * 3 + 1];
    geometry.setAttribute('aParentHeight', new THREE.BufferAttribute(parentHeight, 1));
    geometry.setAttribute('aParentNormal', new THREE.BufferAttribute(data.normals.slice(), 3));
    geometry.setAttribute('aMorphStart', new THREE.BufferAttribute(new Float32Array(n).fill(-1), 1));
    const partition = partitionIndices(data.positions, data.indices);
    data.indices = partition.indices;
    geometry.setIndex(new THREE.BufferAttribute(partition.indices, 1));
    geometry.computeBoundingSphere();
    // The existing distant-ridge shader displaces vertices beyond CPU bounds.
    geometry.boundingSphere.radius += P.farRidgeAmp * 2;
    const mesh = new THREE.Mesh(geometry, [material]);
    mesh.position.set(tile.x0 + tile.C / 2, 0, tile.z0 + tile.C / 2);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.userData.quadrants = partition.ranges;
    mesh.visible = false;
    mesh.name = tile.key;
    return mesh;
  }

  _publish(tile, data) {
    if (!this.requests.has(tile.key) || this.chunks.has(tile.key)) return;
    data = addQuadrantSkirts(data, data.maxY - data.minY + P.skirtDepth + P.farRidgeAmp * 2);
    const mesh = this._mesh(data, this.material, tile);
    mesh.receiveShadow = tile.l <= 1;
    mesh.castShadow = tile.l === 0;
    const entry = { tile, mesh, waterMesh: null, data, mask: 0, revealed: false,
      settled: true, morphEnd: 0, lastUsed: performance.now() / 1000, bytes: 0 };
    if (tile.l <= 4 && this.water) {
      const cell = tile.C / data.resolution;
      const groundAt = (x, z) => {
        const i = Math.round((x - tile.x0) / cell), j = Math.round((z - tile.z0) / cell);
        if (i >= -1 && i <= data.resolution + 1 && j >= -1 && j <= data.resolution + 1) {
          return data.heights[(j + 1) * data.gridSize + i + 1];
        }
        return this.world.ground(x, z);
      };
      const g = Object.hasOwn(data, 'water') ? this.water.geometryFromData(data.water)
        : this.water.buildGeometry(tile.x0, tile.z0, tile.C, this.levelRes(tile.l), groundAt);
      if (g) {
        const partition = partitionIndices(g.getAttribute('position').array, g.index.array);
        g.setIndex(new THREE.BufferAttribute(partition.indices, 1));
        const water = new THREE.Mesh(g, [this.water.material]);
        water.position.copy(mesh.position);
        water.matrixAutoUpdate = false;
        water.updateMatrix();
        water.userData.quadrants = partition.ranges;
        water.renderOrder = 1;
        water.visible = false;
        entry.waterMesh = water;
        this.waterGroup.add(water);
      }
    }
    const buffers = new Set();
    for (const object of [mesh, entry.waterMesh]) if (object) {
      for (const attribute of Object.values(object.geometry.attributes)) buffers.add(attribute.array.buffer);
      buffers.add(object.geometry.index.array.buffer);
    }
    for (const value of Object.values(data)) if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
    if (data.water) for (const value of Object.values(data.water)) buffers.add(value.buffer);
    for (const buffer of buffers) entry.bytes += buffer.byteLength;
    this.group.add(mesh);
    this.chunks.set(tile.key, entry);
    const job = this.jobs.get(tile.key);
    if (job) {
      this._latencies.push(performance.now() - job.queued);
      if (this._latencies.length > 64) this._latencies.shift();
    }
    this.jobs.delete(tile.key);
    this._selectionDirty = true;
  }

  _prepareMorph(entry, now) {
    entry.revealed = true;
    let tile = parentTile(entry.tile), parent = null;
    while (tile.l < P.levels) {
      if (this.renderSet.has(tile.key)) { parent = this.chunks.get(tile.key); break; }
      tile = parentTile(tile);
    }
    if (!parent || !parent.settled || !this.presented) return;
    const geometry = entry.mesh.geometry;
    const positions = geometry.getAttribute('position');
    const heights = geometry.getAttribute('aParentHeight');
    const normals = geometry.getAttribute('aParentNormal');
    const starts = geometry.getAttribute('aMorphStart');
    const p = parent.tile, N = parent.data.resolution, stride = N + 1;
    const source = parent.data.positions, sourceNormals = parent.data.normals;
    for (let k = 0; k < positions.count; k++) {
      const x = entry.tile.x0 + entry.tile.C / 2 + positions.getX(k);
      const z = entry.tile.z0 + entry.tile.C / 2 + positions.getZ(k);
      const fx = clamp((x - p.x0) / p.C * N, 0, N);
      const fz = clamp((z - p.z0) / p.C * N, 0, N);
      const i = Math.min(N - 1, Math.floor(fx)), j = Math.min(N - 1, Math.floor(fz));
      const tx = fx - i, tz = fz - j, a = j * stride + i, d = a + stride + 1;
      const ids = tx + tz <= 1 ? [a, a + 1, a + stride] : [d, d - 1, d - stride];
      const weights = tx + tz <= 1 ? [1 - tx - tz, tx, tz] : [tx + tz - 1, 1 - tx, 1 - tz];
      let y = 0, nx = 0, ny = 0, nz = 0;
      for (let n = 0; n < 3; n++) {
        const at = ids[n] * 3, w = weights[n];
        y += source[at + 1] * w;
        nx += sourceNormals[at] * w; ny += sourceNormals[at + 1] * w; nz += sourceNormals[at + 2] * w;
      }
      y -= entry.data.skirtDepths[k];
      heights.setX(k, y);
      normals.setXYZ(k, nx, ny, nz);
      starts.setX(k, now);
    }
    heights.needsUpdate = normals.needsUpdate = starts.needsUpdate = true;
    entry.settled = false;
    entry.morphFromLevel = parent.tile.l;
    entry.morphEnd = now + P.morphSeconds;
    // Both endpoint surfaces must remain inside the culling bound while morphing.
    geometry.boundingSphere.radius += Math.max(
      Math.abs(parent.data.maxY - entry.data.minY), Math.abs(parent.data.minY - entry.data.maxY));
  }

  dispose() {
    this.scheduler.drop(key => key.startsWith('terr:'));
    this.workerPool.dispose();
    for (const c of this.chunks.values()) this._dispose(c);
    this.chunks.clear();
    this.renderSet.clear();
    this.regions.length = 0;
    for (const texture of new Set([this.uniforms.uGrassDetail.value, this.uniforms.uForestDetail.value, this.fallbackTexture])) texture?.dispose();
    this.plantContact.texture.onUpdate = null;
    this.plantContact.dispose();
    this._plantContactSelection = this._plantContactPendingTiles = null;
    this._plantContactActiveTiles.clear();
    this._plantContactEnabled = this._plantContactDirty = false;
    this.material.dispose();
  }
}
