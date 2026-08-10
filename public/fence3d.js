// The 3D fence preview on the customer estimate page.
//
// Takes the line the customer traced on the satellite map and stands a fence up
// on it — on a picture of their actual yard. The ground is real aerial imagery
// of the property, stitched from the same tiles the map uses, so the fence sits
// exactly where they drew it rather than on an invented lawn.
//
// The imagery comes through our own server (/api/estimate/tile/...) rather than
// straight from Esri. A canvas that has drawn a cross-origin image can't be read
// back, and that would break "Save picture".
//
// Loaded as a module because three.js no longer ships a plain <script> build;
// the camera controls are hand-rolled rather than pulling in the addons bundle
// for what amounts to drag-to-orbit.

import * as THREE from 'three';

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320;
const FT = 0.3048;

// ---------------------------------------------------------------------------
// Fence styles
//
// A rate-book service says what a fence costs, not what it looks like, so each
// one is mapped to the nearest thing we can draw. Anything unrecognised — a
// service the office invented — falls back to privacy boards, and the customer
// can change it: this is a picture, not a specification.
// ---------------------------------------------------------------------------

const STYLES = {
  privacy: {
    label: 'Privacy (solid boards)',
    defaultHeightFt: 6,
    postEvery: 2.44, // 8ft bays
    post: { w: 0.09, colour: 0x8a6a45 },
    infill: 'boards-vertical',
    board: { w: 0.14, gap: 0.005, colour: 0xc09a68 },
    rails: 2,
    rail: { h: 0.09, d: 0.04, colour: 0x8a6a45 },
  },
  picket: {
    label: 'Picket / ornamental',
    defaultHeightFt: 4,
    postEvery: 2.44,
    post: { w: 0.07, colour: 0x3a3a3c },
    infill: 'boards-vertical',
    board: { w: 0.03, gap: 0.09, colour: 0x46464a },
    rails: 2,
    rail: { h: 0.05, d: 0.03, colour: 0x3a3a3c },
  },
  board: {
    label: 'Board / ranch rail',
    defaultHeightFt: 4.5,
    postEvery: 2.9,
    post: { w: 0.11, colour: 0x7d5f3e },
    infill: 'boards-horizontal',
    board: { h: 0.14, d: 0.035, colour: 0xb98f5f },
    boards: 3,
  },
  chainlink: {
    label: 'Chain link',
    defaultHeightFt: 5,
    postEvery: 3.05, // 10ft bays
    post: { w: 0.05, colour: 0x9a9a9e },
    infill: 'mesh',
    rails: 1,
    rail: { h: 0.045, d: 0.045, colour: 0x9a9a9e },
    meshColour: 0xbfc3c7,
  },
  wire: {
    label: 'Wire / high tensile',
    defaultHeightFt: 4,
    postEvery: 4.0,
    post: { w: 0.08, colour: 0x6b5238 },
    infill: 'wires',
    strands: 6,
    wireColour: 0x8d9095,
  },
};

// Rate-book key -> what it looks like.
const KEY_STYLE = {
  wood: 'privacy', vinylp: 'privacy', steel: 'privacy', hybrid: 'privacy',
  ornam: 'picket',
  board: 'board', ranch: 'board', flex: 'board',
  clblack: 'chainlink', clgalv: 'chainlink',
  woven: 'wire', tensile: 'wire',
};
export const styleForService = (key) => KEY_STYLE[key] || 'privacy';
export const styleList = () => Object.keys(STYLES).map((k) => ({ key: k, label: STYLES[k].label }));

// ---------------------------------------------------------------------------
// Web Mercator, and a flat local frame in metres
// ---------------------------------------------------------------------------

const lngToTileX = (lng, z) => ((lng + 180) / 360) * 2 ** z;
const latToTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const tileXToLng = (x, z) => (x / 2 ** z) * 360 - 180;
const tileYToLat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

// Over a single property the earth is flat enough that this is accurate to a
// few centimetres, which is far finer than anyone traces by clicking.
function makeProjector(originLat, originLng) {
  const mPerLng = M_PER_DEG_LNG * Math.cos((originLat * Math.PI) / 180);
  return {
    // North is -Z, which is the direction a Three.js camera looks by default.
    toLocal: ([lat, lng]) => [(lng - originLng) * mPerLng, -(lat - originLat) * M_PER_DEG_LAT],
    mPerLng,
  };
}

// ---------------------------------------------------------------------------
// The ground: satellite tiles stitched into one texture
// ---------------------------------------------------------------------------

const loadTile = (z, x, y) =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    // A missing tile leaves a blank square rather than failing the whole view.
    img.onerror = () => resolve(null);
    img.src = `/api/estimate/tile/${z}/${x}/${y}`;
  });

// Build a texture covering the traced area, and report exactly what ground it
// spans so the plane can be placed to match.
async function buildGround(bounds, project) {
  // Zoom 19 is the finest Esri holds almost everywhere; drop a level at a time
  // if the property is big enough that 19 would need an unreasonable number of
  // tiles to cover.
  let z = 19;
  let x0, x1, y0, y1;
  for (; z >= 15; z--) {
    x0 = Math.floor(lngToTileX(bounds.west, z));
    x1 = Math.floor(lngToTileX(bounds.east, z));
    y0 = Math.floor(latToTileY(bounds.north, z));
    y1 = Math.floor(latToTileY(bounds.south, z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 25) break;
  }

  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = cols * 256;
  canvas.height = rows * 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#5d6b4e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const jobs = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      jobs.push(
        loadTile(z, x, y).then((img) => {
          if (img) ctx.drawImage(img, (x - x0) * 256, (y - y0) * 256, 256, 256);
        })
      );
  await Promise.all(jobs);

  // The exact ground the canvas covers, in local metres.
  const [wx, nz] = project.toLocal([tileYToLat(y0, z), tileXToLng(x0, z)]);
  const [ex, sz] = project.toLocal([tileYToLat(y1 + 1, z), tileXToLng(x1 + 1, z)]);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { texture, west: wx, east: ex, north: nz, south: sz };
}

// ---------------------------------------------------------------------------
// Building the fence
// ---------------------------------------------------------------------------

// One box per instance, positioned and turned to lie along the fence.
function instanced(count, geometry, material, shadows = true) {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return mesh;
}

const matte = (colour) => new THREE.MeshLambertMaterial({ color: colour });

// Turn the traced runs into fence geometry. Everything repeated — posts,
// boards, pickets — goes into an InstancedMesh, so a 300ft picket fence is a
// handful of draw calls instead of a thousand.
function buildFence(runs, project, styleKey, heightM) {
  const style = STYLES[styleKey] || STYLES.privacy;
  const group = new THREE.Group();

  const posts = [];
  const boards = [];
  const rails = [];
  const panels = []; // { centre, angle, length } for mesh / wire infill

  const dummy = new THREE.Object3D();

  for (const run of runs) {
    const pts = run.map((p) => project.toLocal(p));
    if (pts.length < 2) continue;

    // A post on every corner, so the fence turns where the customer clicked.
    for (const [x, z] of pts) posts.push([x, z]);

    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1];
      const [bx, bz] = pts[i];
      const dx = bx - ax;
      const dz = bz - az;
      const length = Math.hypot(dx, dz);
      if (length < 0.2) continue;
      const angle = Math.atan2(dx, dz); // rotation about Y to face along the run

      // Line posts between the corners, evenly spaced so the last bay isn't a
      // stub — real fencing is set out the same way.
      const bays = Math.max(1, Math.round(length / style.postEvery));
      for (let b = 1; b < bays; b++) {
        const t = b / bays;
        posts.push([ax + dx * t, az + dz * t]);
      }

      const centre = [ax + dx / 2, az + dz / 2];
      panels.push({ centre, angle, length });

      if (style.infill === 'boards-vertical') {
        // Fill each bay with uprights, inset so they don't clash with a post.
        const pitch = style.board.w + style.board.gap;
        const n = Math.max(1, Math.floor(length / pitch));
        const spare = length - n * pitch;
        for (let k = 0; k < n; k++) {
          const t = (spare / 2 + pitch * k + pitch / 2) / length;
          boards.push({ x: ax + dx * t, z: az + dz * t, angle });
        }
      }
      if (style.infill === 'boards-horizontal') {
        for (let k = 0; k < style.boards; k++)
          rails.push({
            centre, angle, length,
            y: heightM * ((k + 0.6) / style.boards),
            h: style.board.h, d: style.board.d,
          });
      }
      if (style.rails)
        for (let k = 0; k < style.rails; k++)
          rails.push({
            centre, angle, length,
            // Top rail just under the cap, the rest spread below it.
            y: style.rails === 1 ? heightM - 0.06 : heightM * (k === 0 ? 0.92 : 0.28),
            h: style.rail.h, d: style.rail.d,
          });
    }
  }

  // --- posts ---
  if (posts.length) {
    const g = new THREE.BoxGeometry(style.post.w, heightM + 0.08, style.post.w);
    const mesh = instanced(posts.length, g, matte(style.post.colour));
    posts.forEach(([x, z], i) => {
      dummy.position.set(x, (heightM + 0.08) / 2, z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    group.add(mesh);
  }

  // --- vertical boards / pickets ---
  if (boards.length) {
    const g = new THREE.BoxGeometry(style.board.w, heightM - 0.12, 0.025);
    const mesh = instanced(boards.length, g, matte(style.board.colour));
    boards.forEach((b, i) => {
      dummy.position.set(b.x, (heightM - 0.12) / 2 + 0.1, b.z);
      dummy.rotation.set(0, b.angle, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    group.add(mesh);
  }

  // --- rails / horizontal boards ---
  if (rails.length) {
    // One unit box, stretched per instance to the length of its bay.
    const g = new THREE.BoxGeometry(1, 1, 1);
    const colour = style.infill === 'boards-horizontal' ? style.board.colour : style.rail.colour;
    const mesh = instanced(rails.length, g, matte(colour));
    rails.forEach((r, i) => {
      dummy.position.set(r.centre[0], r.y, r.centre[1]);
      dummy.rotation.set(0, r.angle, 0);
      dummy.scale.set(r.d, r.h, r.length);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      dummy.scale.set(1, 1, 1);
    });
    group.add(mesh);
  }

  // --- chain-link mesh ---
  if (style.infill === 'mesh' && panels.length) {
    const tex = chainLinkTexture();
    for (const p of panels) {
      const mat = new THREE.MeshLambertMaterial({
        map: tex.clone(),
        transparent: true,
        alphaTest: 0.35,
        side: THREE.DoubleSide,
        color: style.meshColour,
      });
      // Repeat the diamond pattern by real size, so it stays the same gauge
      // whatever the bay length.
      mat.map.wrapS = mat.map.wrapT = THREE.RepeatWrapping;
      mat.map.repeat.set(p.length / 0.35, heightM / 0.35);
      mat.map.needsUpdate = true;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(p.length, heightM - 0.08), mat);
      plane.position.set(p.centre[0], (heightM - 0.08) / 2 + 0.04, p.centre[1]);
      plane.rotation.y = p.angle + Math.PI / 2;
      group.add(plane);
    }
  }

  // --- wire strands ---
  if (style.infill === 'wires' && panels.length) {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const total = panels.length * style.strands;
    const mesh = instanced(total, g, matte(style.wireColour), false);
    let i = 0;
    for (const p of panels)
      for (let k = 0; k < style.strands; k++) {
        dummy.position.set(p.centre[0], heightM * ((k + 1) / (style.strands + 0.5)), p.centre[1]);
        dummy.rotation.set(0, p.angle, 0);
        dummy.scale.set(0.012, 0.012, p.length);
        dummy.updateMatrix();
        mesh.setMatrixAt(i++, dummy.matrix);
        dummy.scale.set(1, 1, 1);
      }
    group.add(mesh);
  }

  return group;
}

// A diamond-mesh pattern drawn once and reused for every chain-link panel.
let _chainTex = null;
function chainLinkTexture() {
  if (_chainTex) return _chainTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 64, 64);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(-8, 8); ctx.lineTo(56, 72);
  ctx.moveTo(8, -8); ctx.lineTo(72, 56);
  ctx.moveTo(56, -8); ctx.lineTo(-8, 56);
  ctx.moveTo(72, 8); ctx.lineTo(8, 72);
  ctx.stroke();
  _chainTex = new THREE.CanvasTexture(c);
  _chainTex.colorSpace = THREE.SRGBColorSpace;
  return _chainTex;
}

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

export class FencePreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xdfe6ec);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 4000);
    this.target = new THREE.Vector3();
    this.orbit = { azimuth: Math.PI * 0.25, polar: Math.PI * 0.34, distance: 60 };

    // Daylight: a soft sky/ground bounce plus one sun that casts the shadows.
    this.scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x54603f, 1.1));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.world = new THREE.Group();
    this.scene.add(this.world);

    this._bindControls();
    this._loop = this._loop.bind(this);
    this._running = true;
    requestAnimationFrame(this._loop);
  }

  // Drag to look around, wheel or pinch to move in. Written out rather than
  // pulled from the three.js addons bundle — it is one gesture in each axis.
  _bindControls() {
    const el = this.canvas;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let pinch = 0;

    const start = (x, y) => { dragging = true; lastX = x; lastY = y; };
    const move = (x, y) => {
      if (!dragging) return;
      this.orbit.azimuth -= (x - lastX) * 0.007;
      // Stop just above the horizon and just below straight down, so the view
      // can never end up under the ground looking at the back of the texture.
      this.orbit.polar = Math.min(
        Math.PI * 0.492,
        Math.max(0.08, this.orbit.polar - (y - lastY) * 0.007)
      );
      lastX = x;
      lastY = y;
    };
    const end = () => { dragging = false; pinch = 0; };

    el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); start(e.clientX, e.clientY); });
    el.addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        dragging = false;
        pinch = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
      }
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinch) {
        const d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        this.zoom(pinch / d);
        pinch = d;
      }
    }, { passive: true });
    el.addEventListener('touchend', end);
  }

  zoom(factor) {
    this.orbit.distance = Math.min(this.maxDistance || 600, Math.max(4, this.orbit.distance * factor));
  }

  // Load a traced fence. Everything before is thrown away, so changing style or
  // height just calls this again.
  async load({ runs, styleKey, heightFt }) {
    this.world.clear();
    if (!runs || !runs.length) return;

    const flat = runs.flat();
    const bounds = {
      north: Math.max(...flat.map((p) => p[0])),
      south: Math.min(...flat.map((p) => p[0])),
      east: Math.max(...flat.map((p) => p[1])),
      west: Math.min(...flat.map((p) => p[1])),
    };
    const midLat = (bounds.north + bounds.south) / 2;
    const midLng = (bounds.east + bounds.west) / 2;
    const project = makeProjector(midLat, midLng);

    // Enough of the yard around the fence to place it, and no more — pad too
    // generously and the picture becomes the neighbourhood with a fence in it.
    const padLat = Math.max(0.00012, (bounds.north - bounds.south) * 0.28);
    const padLng = Math.max(0.00016, (bounds.east - bounds.west) * 0.28);
    const padded = {
      north: bounds.north + padLat, south: bounds.south - padLat,
      east: bounds.east + padLng, west: bounds.west - padLng,
    };

    const ground = await buildGround(padded, project);
    const width = Math.abs(ground.east - ground.west);
    const depth = Math.abs(ground.south - ground.north);
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshLambertMaterial({ map: ground.texture })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set((ground.west + ground.east) / 2, 0, (ground.north + ground.south) / 2);
    plane.receiveShadow = true;
    this.world.add(plane);

    const heightM = (heightFt || STYLES[styleKey]?.defaultHeightFt || 6) * FT;
    this.world.add(buildFence(runs, project, styleKey, heightM));

    // Frame the fence, not the whole aerial photo.
    const local = flat.map((p) => project.toLocal(p));
    const cx = (Math.max(...local.map((p) => p[0])) + Math.min(...local.map((p) => p[0]))) / 2;
    const cz = (Math.max(...local.map((p) => p[1])) + Math.min(...local.map((p) => p[1]))) / 2;
    const span = Math.max(
      Math.max(...local.map((p) => p[0])) - Math.min(...local.map((p) => p[0])),
      Math.max(...local.map((p) => p[1])) - Math.min(...local.map((p) => p[1])),
      8
    );
    this.target.set(cx, heightM * 0.5, cz);
    // Fit the fence's bounding circle to the narrower of the two field-of-view
    // angles, so it fills the frame on a phone held upright as well as on a
    // laptop. Pulled in slightly from the exact fit — a fence touching all four
    // edges reads as cramped.
    const xs = local.map((p) => p[0]);
    const zs = local.map((p) => p[1]);
    const radius = Math.max(4, 0.5 * Math.hypot(
      Math.max(...xs) - Math.min(...xs),
      Math.max(...zs) - Math.min(...zs)
    ));
    const vfov = (this.camera.fov * Math.PI) / 180;
    const aspect = (this.canvas.clientWidth || 16) / (this.canvas.clientHeight || 10);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    this.orbit.distance = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 0.82;
    this.maxDistance = radius * 8;

    // Point the sun across the scene and size its shadow box to fit, or the
    // shadows either miss the fence or turn to mush.
    const reach = span * 1.2 + 20;
    this.sun.position.set(cx + reach * 0.6, reach, cz + reach * 0.5);
    this.sun.target.position.set(cx, 0, cz);
    const cam = this.sun.shadow.camera;
    cam.left = -reach; cam.right = reach; cam.top = reach; cam.bottom = -reach;
    cam.near = 1; cam.far = reach * 3;
    cam.updateProjectionMatrix();
  }

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _loop() {
    if (!this._running) return;
    this.resize();
    const { azimuth, polar, distance } = this.orbit;
    this.camera.position.set(
      this.target.x + distance * Math.sin(polar) * Math.sin(azimuth),
      this.target.y + distance * Math.cos(polar),
      this.target.z + distance * Math.sin(polar) * Math.cos(azimuth)
    );
    this.camera.lookAt(this.target);
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._loop);
  }

  // A still of whatever is on screen. Works because every image in the scene
  // came from our own origin — see the note at the top of this file.
  snapshot() {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }

  destroy() {
    this._running = false;
    this.renderer.dispose();
  }
}

export { STYLES };
