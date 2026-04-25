# gsplat-grounding

Drop a character into a Gaussian-splat scene and have them walk on the visible floor — without authoring a collider mesh.

The floor reference is derived **at runtime, in the browser**, by sampling splat-centroid density. The same `.spz` (or `.ply` / `.splat` / `.ksplat`) acts as both the visual environment and the collision source.

**🟢 Live demo: https://omarintern.github.io/gsplat-grounding/**

Drag any splat file onto the page. A capsule character spawns at the world centroid and walks back and forth, feet snapped to the heightmap derived from your splat's data.

## Run locally

```bash
git clone https://github.com/omarintern/gsplat-grounding
cd gsplat-grounding
python3 -m http.server 8000
# open http://localhost:8000
```

No `npm install`, no build step. Three.js and the splat renderer load from CDNs via an importmap.

## Use it in your own project

The whole library is one file: [`src/splat-grounding.js`](src/splat-grounding.js). Copy it into your three.js project and import:

```js
import {
  sampleSplatCenters,
  buildSplatFloorHM,
  sampleSplatFloor,
  groundCharacter,
  buildFloorCarpet,
} from './splat-grounding.js';

// 1. Load your splat with @mkkellogg/gaussian-splats-3d as usual.
const viewer = new GaussianSplats3D.Viewer({ /* your options */ });
await viewer.addSplatScene('./scene.spz');

// 2. Build the floor heightmap from splat density (do this once per splat load).
const samples = sampleSplatCenters(viewer.splatMesh, 30000);
const floorHM = buildSplatFloorHM(samples);

// 3. Per frame, after your AnimationMixer.update(), snap your character.
function tick() {
  mixer.update(dt);              // your character's animation
  groundCharacter(walker, floorHM);
  renderer.render(scene, camera);
}
```

Need to debug? Drop the carpet into your scene:

```js
scene.add(buildFloorCarpet(floorHM));   // green wireframe over the derived floor
```

## What we tried — and what we found

Three options were on the table for "where does the character stand."

1. **Marble Labs' collider mesh.** Tempting, since it ships alongside every splat. But that mesh is authored for **first-person camera collision** — don't fly through walls, don't fall through the world. Its lowest top-facing polygon at any (x, y) is whatever the camera could land on, which includes booth seats, stool feet, and table tops. A character grounded on it climbs onto furniture instead of walking the aisle.
2. **No floor proxy.** Pick a sensible constant Z by eye, plant the character there. Beats option 1 for character navigation (at least nothing climbs furniture) but misses the splat's per-gaussian ripple — the visible floor isn't a perfectly flat plane. A constant Z lets feet sink in the dips and float over the rises.
3. **Splat heightmap (this lib).** Sample the splat directly. Per (x, y), gather nearby splat centroids, sort by Z, then **slide a 15 cm window through the bottom 60% of the sorted list and find the densest position**. The upper edge of that densest band is the visible floor — it adapts to each scene's distribution rather than picking a fixed percentile. The same `.spz` is the visual *and* the floor.

## How it works

### Build the heightmap (once, at load)

1. Pull each splat's xyz centroid via `splatMesh.getSplatCenter(i, vec)` (mkkellogg API), transform by `matrixWorld` to get world-space coords. Stride down to ~30k samples.
2. Compute the world's xy footprint from the 5th–95th percentile of sample positions (ignores stray sky/noise points).
3. Bin the footprint into a 32×32 grid.
4. **Per cell**, gather every sample within `1.5 × cellSize` xy distance, sort by z, then slide a window of `bandWidth` metres through the bottom `searchFraction` of the sorted list and find the densest window position. The upper edge of that densest window is the floor for the cell — it adapts to whatever the actual distribution is in this cell, rather than assuming the floor lives at any fixed percentile.
5. Fill remaining empty cells from neighbours (3 passes).

### Snap the character (every frame)

1. Bilinear-interp the heightmap at the character's `(x, y)` → `floorZ`.
2. Update your AnimationMixer first (so bones reflect the current frame).
3. Compute the character's *live skinned* `Box3.setFromObject(walker, true)` — `precise=true` makes three.js transform every skinned vertex into world space and find the actual lowest point, not the rest pose.
4. Shift `walker.position.z` so `bbox.min.z === floorZ`. Whichever foot is lowest at this instant of the cycle plants on the floor.

### What you get visually

- **Walking animation**: planted foot stays put, swing foot lifts off, hips bob naturally.
- **Slight slope** in the splat's reconstructed floor → character follows the slope.
- **Furniture / booth bases / table legs**: ignored, because they show up as the high z-percentile in their cells, not p15.

## API

```ts
sampleSplatCenters(splatMesh, targetCount = 30000)
  → Array<[x, y, z]>

buildSplatFloorHM(samples, opts?)
  → { heights: Float32Array, nx, ny, xMin, yMin, cellX, cellY }

  opts:
    nx, ny              grid resolution (default 32×32)
    bandWidth           floor band width, metres (default 0.15)
    searchFraction      bottom fraction of each cell's z list to search (default 0.6)
    radiusFactor        gather radius in cells (default 1.5)
    minSamplesPerCell   skip cells with fewer (default 8)
    fillPasses          neighbour-fill iterations (default 3)

sampleSplatFloor(hm, x, y)
  → number | null   bilinear-interp z at (x, y); null if outside or all-NaN

groundCharacter(walker, hm)
  → void   shifts walker.position.z so the live skinned bbox.min sits on hm

buildFloorCarpet(hm, { color?, opacity? })
  → THREE.Mesh   wireframe debug viz of the heightmap
```

## Roadmap

This is the first release in a longer effort to make characters aware of Gaussian-splat scenes the way they're aware of hand-authored worlds.

- **V1 (this release) — Floor awareness.** Character knows where the ground is, follows changes in it (slopes, raised areas, things that protrude from the floor). Kinematic: the lowest body vertex is forced onto the heightmap every frame.
- **V2 — Physics dynamics on the heightmap.** Replace the kinematic snap with a one-sided collision against the heightmap plus gravity on the character's pivot. Unlocks jumps, falls, knockbacks, dives — any airborne motion. The heightmap stops being a constraint and becomes collision geometry.
- **V3 — Artefact correction.** Splat reconstructions contain floating wisps and ghost ellipsoids; V3 distinguishes real geometry from noise so the blocked-vs-walkable signal is clean.
- **V4+ — Object segmentation.** Recognise discrete objects in the splat (chair, door, jukebox) so a character can sit, open, pick up — i.e. *interact* with the scene, not just walk through it.

## Limitations

This is a **single-floor** approximation: `z = f(x, y)`, one Z per xy.

- ✅ indoor scenes with a clear horizontal floor (rooms, galleries, diners, halls)
- ✅ outdoor terrain with smooth elevation changes
- ❌ stairs, balconies, multi-storey buildings (you can't walk on top of *and* under the same xy)
- ❌ overhangs (low ceiling, walking under a table)
- ❌ very sparse splats — cells with fewer than 8 samples fall back to neighbours

The dense-band cutoff is more robust than a hardcoded percentile but isn't a panacea. Scenes with very thick sub-floor noise, very sparse floor coverage, or low-rise furniture (rugs, cushions) can still confuse it; you may need to tune `bandWidth` or `searchFraction`. True scene-content awareness — distinguishing "this splat is floor" from "this splat is rug" — needs object segmentation, which is on the roadmap as V4.

For multi-floor support, the heightmap would need to store *all* dense z-bands per cell and let the walker pick the band closest to its current z. Not in V1.

## Splat orientation

Splats from different sources use different up-axes. The demo applies `splatRoot.rotation.x = -Math.PI / 2` because Marble Labs exports Y-down. For other sources:

| source | orientation | rotation |
|---|---|---|
| Marble Labs | Y-down | `rotation.x = -π/2` |
| Lyra (NVIDIA) | Y-up | `rotation.x = +π/2` |
| Polycam | varies | check sample bounds |

If your character ends up upside-down, flip the sign of the rotation.

## Performance

The current pipeline runs the splat sort on the CPU (`gpuAcceleratedSort: false`) because mkkellogg's GPU-sort path needs cross-origin-isolation headers (`Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`) that `python -m http.server` doesn't set. Expect 10–30 fps on a 500k splat.

For ~60 fps with the GPU-sort path, you'll need to:

1. Vendor `@mkkellogg/gaussian-splats-3d` locally instead of the CDN.
2. Serve with COOP/COEP headers (any modern dev server: `vite`, `http-server -S`, etc.).
3. Set `gpuAcceleratedSort: true` and `sharedMemoryForWorkers: true` in `Viewer` options.

## Credits

- [@mkkellogg](https://github.com/mkkellogg) for [`@mkkellogg/gaussian-splats-3d`](https://github.com/mkkellogg/GaussianSplats3D) — handles all the actual splat decoding and rendering.
- [three.js](https://threejs.org/) for the renderer, `Box3.setFromObject(obj, true)` (skinned bbox), `AnimationMixer`, and everything else underneath.

## License

MIT — see [LICENSE](LICENSE).
