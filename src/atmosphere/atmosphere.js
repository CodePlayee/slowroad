// src/atmosphere/atmosphere.js
// Owns: time of day, season, weather -> sun/moon position, light colours, sky uniforms,
// haze uniforms, grade uniforms, and the shared palette other systems read.
//
// Everything visual is driven off SUN ELEVATION rather than clock time, so it is
// automatically correct for every season and for the whole 0-24 range.

import * as THREE from 'three';
import { ATMO, SEASONS, WEATHER } from './params.js';
import { createSky } from './sky.js';
import { skyUniforms } from './skylib.js';
import { installFog, fogUniforms, registerFogMaterial } from './fog.js';
import { installToneMapping, gradeUniforms } from './tonemap.js';
import { clamp, lerp, smoothstep } from '../core/rng.js';

const _a = new THREE.Color();
const _b = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);
const LUMA = [0.2126, 0.7152, 0.0722];

function rampColor(ramp, x, out) {
  if (x <= ramp[0][0]) { const c = ramp[0][1]; return out.setRGB(c[0], c[1], c[2]); }
  for (let i = 1; i < ramp.length; i++) {
    if (x <= ramp[i][0]) {
      const a = ramp[i - 1], b = ramp[i];
      const t = (x - a[0]) / (b[0] - a[0]);
      return out.setRGB(lerp(a[1][0], b[1][0], t), lerp(a[1][1], b[1][1], t), lerp(a[1][2], b[1][2], t));
    }
  }
  const c = ramp[ramp.length - 1][1];
  return out.setRGB(c[0], c[1], c[2]);
}
const _ramp = new THREE.Color();
function rampVec(ramp, x) {
  rampColor(ramp, x, _ramp);
  return [_ramp.r, _ramp.g, _ramp.b];
}
/** 4-component ramp read. THREE.Color only carries 3, so interpolate by hand. */
function rampVec4(ramp, x) {
  const n = ramp[0][1].length;
  const at = (e) => e[1].slice(0, n);
  if (x <= ramp[0][0]) return at(ramp[0]);
  for (let i = 1; i < ramp.length; i++) {
    if (x <= ramp[i][0]) {
      const a = ramp[i - 1], b = ramp[i];
      const t = (x - a[0]) / (b[0] - a[0]);
      return a[1].map((v, k) => lerp(v, b[1][k], t));
    }
  }
  return at(ramp[ramp.length - 1]);
}
function rampScalar(ramp, x) { return rampVec(ramp, x)[0]; }

/** Pull a colour toward its own luminance. k=1 leaves it untouched. */
function desat(c, k) {
  const l = c.r * LUMA[0] + c.g * LUMA[1] + c.b * LUMA[2];
  c.setRGB(lerp(l, c.r, k), lerp(l, c.g, k), lerp(l, c.b, k));
  return c;
}

export class Atmosphere {
  constructor(scene, renderer) {
    // Both of these patch THREE.ShaderChunk and MUST run before any material compiles.
    installFog();
    installToneMapping(renderer);

    this.scene = scene;
    this.renderer = renderer;
    scene.fog = new THREE.FogExp2(0x99aabb, 1e-6); // presence only: enables USE_FOG

    this.time = 12;
    this.seasonName = 'summer';
    this.weatherName = 'clear';

    this.sky = createSky();
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = ATMO.shadow.enabled;
    const sh = this.sun.shadow;
    sh.mapSize.set(ATMO.shadow.mapSize, ATMO.shadow.mapSize);
    sh.camera.near = ATMO.shadow.near;
    sh.camera.far = ATMO.shadow.far;
    sh.camera.left = -ATMO.shadow.extent; sh.camera.right = ATMO.shadow.extent;
    sh.camera.top = ATMO.shadow.extent; sh.camera.bottom = -ATMO.shadow.extent;
    sh.bias = ATMO.shadow.bias;
    sh.normalBias = ATMO.shadow.normalBias;
    this.sun.target.position.set(0, 0, 0);
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbcd4f0, 0x50503c, 0.8);
    scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.25);
    scene.add(this.ambient);

    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.moonDir = new THREE.Vector3(0, -1, 0);
    this.sunElev = 1;
    this.palette = {};
    this._cloudDrift = new THREE.Vector2();
    this.apply();
  }

  register(mat) { return registerFogMaterial(mat); }

  get season() { return SEASONS[this.seasonName] || SEASONS.summer; }
  get weather() { return WEATHER[this.weatherName] || WEATHER.clear; }

  set({ t, season, weather } = {}) {
    if (t !== undefined && Number.isFinite(t)) this.time = ((t % 24) + 24) % 24;
    if (typeof season === 'string' && Object.hasOwn(SEASONS, season)) this.seasonName = season;
    if (typeof weather === 'string' && Object.hasOwn(WEATHER, weather)) this.weatherName = weather;
    this.apply();
  }

  /** Sun position from hour angle, declination (season) and latitude. */
  _solar() {
    const S = this.season;
    const dec = 0.409105 * Math.sin(2 * Math.PI * (S.dayOfYear - 80.5) / 365);
    const H = (this.time - 12) * (Math.PI / 12);
    const lat = ATMO.latitude;
    const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
    const el = Math.asin(clamp(sinEl, -1, 1));
    const cosEl = Math.max(1e-4, Math.cos(el));
    let cosAz = (Math.sin(dec) - Math.sin(lat) * sinEl) / (Math.cos(lat) * cosEl);
    cosAz = clamp(cosAz, -1, 1);
    let az = Math.acos(cosAz);            // 0 = north
    if (H > 0) az = 2 * Math.PI - az;     // afternoon -> west
    // world: +X east, +Z south, +Y up
    return { el, az, x: -Math.sin(az) * cosEl, y: Math.sin(el), z: Math.cos(az) * cosEl };
  }

  apply() {
    const S = this.season, W = this.weather;
    // Winter gets its own restrained overcast bias even when the query keeps clear
    // weather. This is an atmosphere-only cue: it keeps the snow field readable
    // without changing any route, camera, or streamed geometry.
    const winterSeason = this.seasonName === 'winter';
    const greyLevel = Math.max(W.grey, winterSeason ? 0.62 : 0);
    const s = this._solar();
    const el = s.el;
    this.sunElev = el;
    this.sunDir.set(s.x, s.y, s.z).normalize();

    // moon: roughly antisolar, offset so it is not a perfect mirror, and rising as the
    // month advances (driven off dayOfYear so it is deterministic per season).
    this.moonDir.copy(this.sunDir).multiplyScalar(-1);
    this.moonDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.42);
    this.moonDir.y += 0.18;
    this.moonDir.normalize();
    const moonPhase = Math.cos(2 * Math.PI * (S.dayOfYear % 29.53) / 29.53) * 0.75;

    const dayness = clamp((Math.sin(el) + 0.085) / 0.26, 0, 1);
    const nightness = 1 - dayness;
    // Only the seasonal addition needs compensation: explicit overcast/storm
    // already carry matching cloud and light settings. Leave night lighting alone.
    const seasonalCloud = (greyLevel - W.grey) * dayness;
    const moonUp = clamp((this.moonDir.y + 0.04) / 0.28, 0, 1);
    // 1 near the horizon in either direction — drives the mist and the warm horizon band
    const twilight = clamp(1 - Math.abs(el) / 0.24, 0, 1);

    // ---------------------------------------------------------------- sky stops
    const grey = new THREE.Color(...rampVec(ATMO.overcastRamp, el));
    const gradFactor = [0.88, 0.97, 1.07];   // keeps a whisper of gradient when overcast
    const stops = [ATMO.zenithRamp, ATMO.midRamp, ATMO.horizonRamp, ATMO.sunHazeRamp]
      .map((ramp, i) => {
        const c = new THREE.Color(...rampVec(ramp, el));
        c.multiplyScalar(W.gain);
        if (W.sat !== 1) desat(c, W.sat);
        if (greyLevel > 0.001) {
          const gf = gradFactor[Math.min(i, 2)];
          c.setRGB(
            lerp(c.r, grey.r * gf, greyLevel),
            lerp(c.g, grey.g * gf, greyLevel),
            lerp(c.b, grey.b * gf, greyLevel),
          );
        }
        // seasonal tint (autumn warmer, winter cooler)
        const t = S.fogTint;
        c.setRGB(c.r * t[0], c.g * t[1], c.b * t[2]);
        return c;
      });
    const [zen, mid, hor, sunHaze] = stops;

    const sunColor = new THREE.Color(...rampVec(ATMO.sunColorRamp, el));
    const shape = rampVec4(ATMO.shapeRamp, el);

    const u = skyUniforms;
    u.uSkyZenith.value.copy(zen);
    u.uSkyMid.value.copy(mid);
    u.uSkyHorizon.value.copy(hor);
    u.uSkySunHaze.value.copy(sunHaze);
    // Looking DOWN through haze. Must stay close to `hor` in hue (scaling a B/R=25
    // colour down reveals its true chroma and paints distant hills electric blue) but
    // must also stay BELOW it in value, because the free horizon is the brightest thing
    // in a hazy frame and no distant ridge should out-shine the sky above it
    // (sr_03: far ridge V0.87-0.93 against sky V1.00).
    u.uSkyGround.value.copy(hor).multiplyScalar(0.52);
    desat(u.uSkyGround.value, 0.90);
    // wedge amount collapses when overcast — an overcast sky has no sunward glow
    u.uSkyShape.value.set(shape[0], shape[1], shape[2], shape[3] * (1 - greyLevel * 0.96));

    u.uSunDir.value.copy(this.sunDir);
    u.uSunTint.value.copy(sunColor);
    u.uSunLobe.value.set(
      0.76,
      rampScalar(ATMO.sunAureoleRamp, el) * (1 - greyLevel * 0.92) * W.gain,
      rampScalar(ATMO.sunDiscRamp, el) * (1 - clamp(greyLevel * 1.15, 0, 1)),
      0.0075,
    );

    u.uMoonDir.value.copy(this.moonDir);
    u.uNight.value.set(
      nightness * moonUp * (1 - greyLevel * 0.98),
      moonPhase,
      clamp(nightness * 1.3 - 0.14, 0, 1) * (1 - greyLevel * 0.99),
      0.85 * (1 - greyLevel),
    );

    // ---------------------------------------------------------------- clouds
    const cl = W.cloud;
    const winterDeck = WEATHER.overcast.cloud;
    u.uCloud.value.set(
      lerp(cl[0], winterDeck[0], seasonalCloud),
      lerp(cl[1], winterDeck[1], seasonalCloud),
      lerp(cl[2], winterDeck[2], seasonalCloud),
      lerp(cl[3], winterDeck[3], seasonalCloud),
    );
    u.uCloudDrift.value.w = lerp(W.soft, WEATHER.overcast.soft, seasonalCloud);
    // Sunlit tops take the sun's colour, whitened. AT NIGHT THE SUN MUST NOT LIGHT THEM:
    // a fixed 0.55 floor on the day gain left the deck ~20x brighter than a 0.011 night
    // sky, so the night frames had salmon-lit clouds and a V0.40 "sky". Night clouds are
    // lit by the sky itself plus a little moonlight, which makes them read as dark holes
    // in the starfield — which is what sr_14 and sr_20 show.
    const litDay = new THREE.Color().copy(sunColor).lerp(WHITE, 0.30)
      .multiplyScalar(lerp(0.55, 3.1, Math.pow(clamp(dayness, 0, 1), 0.65)));
    const litNight = new THREE.Color().copy(mid).multiplyScalar(1.5);
    const mt = u.uMoonTint.value, mk = 0.022 * moonUp;
    litNight.setRGB(litNight.r + mt.r * mk, litNight.g + mt.g * mk, litNight.b + mt.b * mk);
    u.uCloudLit.value.copy(litNight).lerp(litDay, dayness).multiplyScalar(1 - greyLevel * 0.55);
    if (greyLevel > 0.5) u.uCloudLit.value.lerp(grey, (greyLevel - 0.5) * 1.7);
    u.uCloudDark.value.copy(mid)
      .multiplyScalar(lerp(0.85, 0.42, greyLevel) * lerp(0.55, 1.0, dayness));
    if (greyLevel > 0.001) {
      u.uCloudDark.value.lerp(_a.copy(grey).multiplyScalar(0.80), greyLevel * 0.9);  // _a free here
    }

    // ---------------------------------------------------------------- haze
    const winterHaze = winterSeason ? 1.52 : 1;
    const hazeDensity = lerp(ATMO.hazeDensityDay, ATMO.hazeDensityDawn, twilight) *
      S.density * W.haze * winterHaze;
    const hazeDistance = lerp(ATMO.hazeDistanceDay, ATMO.hazeDistanceDawn, twilight) *
      W.haze * (winterSeason ? 1.28 : 1);
    fogUniforms.uHazeA.value.set(hazeDensity, ATMO.hazeFalloff, ATMO.hazeBaseY, hazeDistance);

    // valley mist: strongest right around sunrise/sunset, present but weaker at night,
    // absent in the middle of the day.
    const mistWindow = Math.pow(clamp(1 - Math.abs(el) / 0.17, 0, 1), 1.3);
    const mistNight = clamp(-el / 0.5, 0, 1) * 0.55;
    const mistAmt = Math.max(mistWindow, mistNight);
    fogUniforms.uHazeB.value.set(
      ATMO.mistDensityDawn * mistAmt * (S.mist || 1) * W.mist * (winterSeason ? 1.18 : 1),
      ATMO.mistFalloff, ATMO.mistBaseY, 1,
    );
    // the mist body is optically thick and locally lit: near the horizon it takes the
    // warm horizon colour, higher up it stays cool.
    // Keep the valley layer a little cooler and darker than the free horizon so
    // low-lying mist separates from the sky instead of flattening distant ridges.
    fogUniforms.uMistColor.value.copy(hor).lerp(_b.copy(mid), 0.45).multiplyScalar(1.02);
    desat(fogUniforms.uMistColor.value, 0.68);
    // Preserve the warm headlight pool and local terrain colour after dark;
    // daytime haze can afford stronger chroma loss, while night reference frames
    // keep the lit foreground as the most saturated part of the image.
    fogUniforms.uAerial.value.set(
      ATMO.aerialDesat * (winterSeason ? 1.12 : 1) * lerp(1.0, 0.72, nightness),
      winterSeason ? 0.86 : ATMO.aerialDarkPow,
      ATMO.mistTintBlend,
      winterSeason ? lerp(2.35, 2.0, nightness) : lerp(ATMO.aerialMixGamma, 2.4, nightness),
    );
    // Same far-distance curve for every time of day and weather (see ATMO.aerialFar).
    fogUniforms.uAerialFar.value.fromArray(ATMO.aerialFar);
    // compat hook for water.js's grazing sky reflection — see fog.js.
    // water.js mixes up to 59% of this into the surface, so it must be peak-limited: a
    // clear-day horizon is 4.3 in linear blue and fed raw it made every lake a band of
    // pure #ffffff. Capping the max channel preserves hue and day/night range.
    const cap = (c, m) => {
      const k = Math.max(c.r, c.g, c.b);
      if (k > m) c.multiplyScalar(m / k);
      return c;
    };
    cap(fogUniforms.uFogColorHigh.value.copy(mid), 0.80);
    cap(fogUniforms.uFogColorLow.value.copy(hor), 1.00);

    // ---------------------------------------------------------------- lights
    // Keep a directional edge at low sun.  The old fill stayed at its noon value
    // through the golden window, washing out long shadows and making the terrain
    // read as one flat card.  A modest key boost plus a lower sky fill preserves the
    // warm-hour cue without changing the authored sky ramps.
    const lowSunContrast = smoothstep(0.08, 0.42, Math.max(Math.sin(el), 0));
    const sunI = ATMO.sunPeak * dayness * W.sun * lerp(1.06, 1.0, lowSunContrast);
    // Winter's grey sky scatters part of the key into diffuse skylight instead
    // of leaving clear-weather illumination beneath an overcast-looking dome.
    const seasonalDiffuse = sunI * seasonalCloud * 0.45;
    if (dayness > 0.02) {
      this.sun.color.copy(sunColor).lerp(WHITE, 0.12);
      this.sun.intensity = sunI - seasonalDiffuse;
    } else {
      this.sun.color.setRGB(0.60, 0.70, 1.0);
      this.sun.intensity = ATMO.moonPeak * moonUp * W.sun;
    }
    this.sun.castShadow = ATMO.shadow.enabled && this.sun.intensity > 0.12;

    // Hemisphere fill IS the sky, so drive its HUE from the sky stops rather than a guess.
    // Normalise by the MAX channel, not by luminance: a clear zenith is ~30x more blue
    // than red, and luminance-normalising it produces a light with b=4.4 which paints
    // every shadowed surface electric blue.
    const skyFill = _b.copy(mid).lerp(hor, 0.45);
    const mx = Math.max(skyFill.r, skyFill.g, skyFill.b, 1e-4);
    // Keep a blue cast in the moonlit fill instead of whitening every shadow;
    // this separates the cool environment from the warmer headlight cone.
    skyFill.multiplyScalar(1 / mx).lerp(WHITE, lerp(0.78, 0.58, nightness));
    this.hemi.color.copy(skyFill);
    this.hemi.groundColor.setRGB(0.19, 0.18, 0.135).lerp(skyFill, 0.16);
    const overcastFill = 1 + W.grey * 1.85;
    // A small moonlit fill keeps the road and vegetation legible at night without
    // lifting the sky itself. The prior 0.10 floor left all unlit cards as black slabs.
    const nightFill = 1 + nightness * 0.85;
    const dayFill = (0.44 + 0.56 * lowSunContrast) * Math.pow(dayness, 0.75);
    this.hemi.intensity = ATMO.hemiPeak * (0.22 + 0.78 * dayFill) * overcastFill * nightFill;
    // Add only a small, moon-upward contribution to the hemisphere: it improves
    // terrain and foliage readability without lifting the ambient floor or the sky.
    // W.sun keeps clouded nights subdued, while nightness leaves every daytime
    // and seasonal daylight result unchanged.
    const moonHemisphereFill = 0.04 * nightness * moonUp * W.sun;
    this.hemi.intensity += moonHemisphereFill;
    this.ambient.color.copy(this.hemi.color);
    const ambientFill = 0.52 + 0.48 * lowSunContrast;
    this.ambient.intensity = ATMO.ambientPeak * (0.30 + 0.70 * dayness) * ambientFill * overcastFill * nightFill;
    // Redistribute, rather than add exposure: upward-facing ground receives the
    // lost key irradiance as skylight, softening snow-bank directional contrast.
    this.hemi.intensity += seasonalDiffuse * Math.max(this.sunDir.y, 0);
    // Clear daylight needs less omnidirectional fill inside crowns and beneath
    // grass blades. Moving it to the hemisphere preserves upward-facing brightness
    // (both lights share a colour), but lets side/down-facing surfaces stay darker.
    // The transfer vanishes at night and is restrained under explicit cloud cover.
    const directionalFill = this.ambient.intensity * 0.25 * dayness * (1 - greyLevel);
    this.ambient.intensity -= directionalFill;
    this.hemi.intensity += directionalFill;

    // ---------------------------------------------------------------- grade
    gradeUniforms.uGradeLook.value.set(ATMO.gradeSlope, ATMO.gradePower, ATMO.gradeSat, 0);
    gradeUniforms.uGradeShadow.value.setRGB(...rampVec(ATMO.gradeShadowRamp, el));
    gradeUniforms.uGradeHigh.value.setRGB(...rampVec(ATMO.gradeHighRamp, el));
    gradeUniforms.uGradeVig.value.set(
      lerp(ATMO.vignetteNight, ATMO.vignetteDay, Math.pow(dayness, 0.55)),
      ATMO.vignetteRadius, ATMO.dither, 0,
    );

    // ---------------------------------------------------------------- palette
    this.palette = {
      grassLush: S.grassLush, grassDry: S.grassDry, foliage: S.foliage, conifer: S.conifer,
      rock: S.rock, sand: S.sand, snowAmount: S.snowAmount, snowLine: S.snowLine,
      leafiness: S.leafiness, dayness, nightness, sunColor,
    };
    this.renderer.toneMappingExposure = ATMO.exposure;
  }

  /** Called each frame: keep the sky and shadow frustum around the camera. */
  update(camera, focus, dt) {
    this.sky.position.copy(camera.position);
    this.sky.scale.setScalar(camera.far * 0.92);

    // Cloud drift is DERIVED from uSkyTime rather than accumulated separately, because
    // main.js's resnap() zeroes `sky.userData.uniforms.uTime` (aliased to uSkyTime in
    // sky.js) to make two captures of the same query byte-identical. An independent
    // accumulator would survive the reset and break determinism.
    skyUniforms.uSkyTime.value += dt;
    const ct = skyUniforms.uSkyTime.value;
    skyUniforms.uCloudDrift.value.x = ct * 0.0125;
    skyUniforms.uCloudDrift.value.y = ct * 0.0062;
    skyUniforms.uCloudDrift.value.z = ct * 0.0260;

    const w = this.renderer.domElement.width || 1920;
    const h = this.renderer.domElement.height || 1080;
    gradeUniforms.uGradeRes.value.set(w, h);

    const f = focus || camera.position;
    this.sun.target.position.set(f.x, f.y, f.z);
    const d = this.palette.dayness > 0.02 ? this.sunDir : this.moonDir;
    this.sun.position.set(f.x + d.x * 300, f.y + d.y * 300, f.z + d.z * 300);
    this.sun.target.updateMatrixWorld();
  }
}
