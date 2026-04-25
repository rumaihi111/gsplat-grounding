// gsplat-grounding — runtime collider extraction from Gaussian-splat density.
// Sample a splat's centroids, build a 2D floor heightmap, snap any character's
// lowest live vertex to it each frame. No preprocessing step, no authored
// collider mesh.
//
// MIT License — see LICENSE.

import * as THREE from 'three';

/**
 * Pull splat centroids out of an mkkellogg `splatMesh` into a flat
 * [[x, y, z], ...] array in *world* space (matrixWorld applied).
 *
 * @param {object} splatMesh         mkkellogg splatMesh (`viewer.splatMesh`).
 * @param {number} [targetCount=30000]  approximate sample budget; uses stride.
 * @returns {Array<[number, number, number]>}
 */
export function sampleSplatCenters(splatMesh, targetCount = 30000) {
  const total = splatMesh.getSplatCount?.() ?? 0;
  if (total === 0) return [];
  const stride = Math.max(1, Math.floor(total / targetCount));
  const samples = [];
  const tmp = new THREE.Vector3();
  splatMesh.updateMatrixWorld?.(true);
  const matWorld = splatMesh.matrixWorld;
  for (let i = 0; i < total; i += stride) {
    splatMesh.getSplatCenter(i, tmp, false);
    tmp.applyMatrix4(matWorld);
    samples.push([tmp.x, tmp.y, tmp.z]);
  }
  return samples;
}

/**
 * Build a 2D floor heightmap from splat-center samples.
 *
 * Per cell: gather all samples within `radiusFactor * cellSize` xy distance,
 * sort by z, then **slide a window of `bandWidth` metres through the bottom
 * `searchFraction` of the sorted z values and find the densest position.**
 * The upper edge of that densest band is the visible floor for that cell.
 *
 * Why this and not a fixed percentile: real splats have wildly different
 * sub-floor noise levels, floor coverage, and furniture density. A hardcoded
 * percentile only lands on the floor when the scene's distribution matches
 * the one it was tuned for. The dense-band approach adapts: it finds the
 * actual concentration of low-z splats wherever it sits in the sorted list.
 *
 * @param {Array<[number, number, number]>} samples
 * @param {object}  [opts]
 * @param {number}  [opts.nx=32]
 * @param {number}  [opts.ny=32]
 * @param {number}  [opts.bandWidth=0.15]      width of the floor band, in metres
 * @param {number}  [opts.searchFraction=0.6]  search the bottom N of each cell's z list
 * @param {number}  [opts.radiusFactor=1.5]    gather radius in cells
 * @param {number}  [opts.minSamplesPerCell=8] skip cells with fewer
 * @param {number}  [opts.fillPasses=3]        neighbour-fill iterations
 * @returns {{
 *   heights: Float32Array, nx: number, ny: number,
 *   xMin: number, yMin: number, cellX: number, cellY: number
 * }}
 */
export function buildSplatFloorHM(samples, opts = {}) {
  const {
    nx = 32,
    ny = 32,
    bandWidth = 0.15,
    searchFraction = 0.6,
    radiusFactor = 1.5,
    minSamplesPerCell = 8,
    fillPasses = 3,
  } = opts;
  if (!samples.length) {
    return { heights: new Float32Array(nx * ny), nx, ny, xMin: 0, yMin: 0, cellX: 1, cellY: 1 };
  }
  // Footprint = p05–p95 of samples to ignore stray points (sky, noise, etc.).
  const xs = samples.map(s => s[0]).sort((a, b) => a - b);
  const ys = samples.map(s => s[1]).sort((a, b) => a - b);
  const pct = (a, p) => a[Math.floor(a.length * p)];
  const xMin = pct(xs, 0.05), xMax = pct(xs, 0.95);
  const yMin = pct(ys, 0.05), yMax = pct(ys, 0.95);
  const cellX = (xMax - xMin) / nx;
  const cellY = (yMax - yMin) / ny;
  const radius = Math.max(cellX, cellY) * radiusFactor;
  const r2 = radius * radius;
  const heights = new Float32Array(nx * ny);
  for (let i = 0; i < heights.length; i++) heights[i] = NaN;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cx = xMin + (i + 0.5) * cellX;
      const cy = yMin + (j + 0.5) * cellY;
      const zs = [];
      for (const [x, y, z] of samples) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        zs.push(z);
      }
      if (zs.length < minSamplesPerCell) continue;
      zs.sort((u, v) => u - v);
      heights[j * nx + i] = densestBandUpper(zs, bandWidth, searchFraction);
    }
  }
  // Fill empty cells from neighbours so the lookup never falls through to NaN.
  const filled = new Float32Array(heights);
  for (let pass = 0; pass < fillPasses; pass++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!isNaN(filled[j * nx + i])) continue;
        let sum = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || ii >= nx || jj < 0 || jj >= ny) continue;
            const v = filled[jj * nx + ii];
            if (!isNaN(v)) { sum += v; n++; }
          }
        }
        if (n > 0) filled[j * nx + i] = sum / n;
      }
    }
  }
  return { heights: filled, nx, ny, xMin, yMin, cellX, cellY };
}

/**
 * Slide a window of width `bandWidth` (metres) through sorted z values `zs`.
 * Find the densest window position inside the bottom `searchFraction` of the
 * data and return its upper edge — the visible floor surface for that cell.
 *
 * Adapts to each scene's distribution:
 * - clean scene with thin floor band → window settles low and tight.
 * - noisy scene with diffuse sub-floor → window skips past the noise to where
 *   actual splats are dense.
 * - sparse floor + dense walls → searchFraction caps the search so a wall
 *   band can't be mistaken for the floor.
 *
 * Two-pointer sweep: O(n) per cell, n = splat count in cell.
 */
function densestBandUpper(zs, bandWidth, searchFraction) {
  const n = zs.length;
  const searchEnd = Math.max(2, Math.floor(n * searchFraction));
  let bestCount = 0;
  let bestUpper = zs[0];
  let hi = 0;
  for (let lo = 0; lo < searchEnd; lo++) {
    if (hi < lo) hi = lo;
    while (hi < n && zs[hi] - zs[lo] <= bandWidth) hi++;
    const count = hi - lo;       // splats in [lo, hi - 1]
    if (count > bestCount) {
      bestCount = count;
      bestUpper = zs[hi - 1];
    }
  }
  return bestUpper;
}

/**
 * Bilinear sample of a heightmap at (x, y).
 * Returns null when outside the heightmap or when all four corners are NaN.
 */
export function sampleSplatFloor(hm, x, y) {
  if (!hm) return null;
  const fx = (x - hm.xMin) / hm.cellX;
  const fy = (y - hm.yMin) / hm.cellY;
  const i0 = Math.max(0, Math.min(hm.nx - 2, Math.floor(fx)));
  const j0 = Math.max(0, Math.min(hm.ny - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - i0));
  const ty = Math.max(0, Math.min(1, fy - j0));
  const z00 = hm.heights[j0 * hm.nx + i0];
  const z10 = hm.heights[j0 * hm.nx + i0 + 1];
  const z01 = hm.heights[(j0 + 1) * hm.nx + i0];
  const z11 = hm.heights[(j0 + 1) * hm.nx + i0 + 1];
  const valid = [z00, z10, z01, z11].filter(v => !isNaN(v));
  if (valid.length === 0) return null;
  if (valid.length < 4) return valid.reduce((s, v) => s + v, 0) / valid.length;
  return z00 * (1 - tx) * (1 - ty) +
         z10 * tx * (1 - ty) +
         z01 * (1 - tx) * ty +
         z11 * tx * ty;
}

/**
 * Snap a character (Object3D, possibly containing a SkinnedMesh) so its lowest
 * live vertex sits on the heightmap at its current xy position.
 *
 * Call AFTER your AnimationMixer.update() each frame so the bounding box
 * reflects the current pose. Uses precise bounding-box computation so skinned
 * geometry is honoured.
 */
const _bbox = new THREE.Box3();
export function groundCharacter(walker, hm) {
  if (!walker) return;
  const floorZ = sampleSplatFloor(hm, walker.position.x, walker.position.y);
  if (floorZ == null) return;
  _bbox.setFromObject(walker, true);   // precise=true → live skinned bounds
  walker.position.z += floorZ - _bbox.min.z;
}

/**
 * Build a debug-viz `THREE.Mesh` (wireframe) showing the heightmap as a
 * carpet draped over the world. Useful for verifying the floor surface
 * matches what the splat actually shows.
 */
export function buildFloorCarpet(hm, opts = {}) {
  const { color = 0x33ff66, opacity = 0.85 } = opts;
  const { nx, ny, xMin, yMin, cellX, cellY, heights } = hm;
  const positions = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = (j * nx + i) * 3;
      positions[idx]     = xMin + i * cellX;
      positions[idx + 1] = yMin + j * cellY;
      positions[idx + 2] = isNaN(heights[j * nx + i]) ? -1e3 : heights[j * nx + i];
    }
  }
  const indices = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = j * nx + i + 1;
      const c = (j + 1) * nx + i;
      const d = (j + 1) * nx + i + 1;
      indices.push(a, b, d, a, d, c);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex(indices);
  const mat = new THREE.MeshBasicMaterial({
    color, wireframe: true, transparent: true, opacity, depthTest: true, toneMapped: false,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = 'splat-floor-carpet';
  mesh.renderOrder = 999;
  return mesh;
}
