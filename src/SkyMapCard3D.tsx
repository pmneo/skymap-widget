import { useEffect, useRef, useState } from 'react';
import type { SkyMapDataSource } from './dataSource';
import type { AstrobinFootprint } from './types';

// Aladin Lite v3 is loaded via <script>, not bundled — see SkyMapCard.tsx's own identical
// declaration for why.
declare global {
  interface Window {
    A: any;
  }
}

/** PROOF OF CONCEPT — not wired into the real app anywhere, not feature-complete (no palette
 * picker, no mount/horizon overlays, no popovers, nothing SkyMapCard.tsx otherwise has): this
 * exists to answer one question empirically. SkyMapCard.tsx's AstroBin footprint mesh (see its own
 * ASTROBIN_MESH_GRID_SIZE / computeFootprintMesh / drawTexturedTriangle) shows faint but real seams
 * along mesh-cell boundaries, worse against a smooth/dark background — confirmed live that neither
 * a bigger clip-path overlap nor `globalCompositeOperation = 'copy'` fixes it (see
 * drawTexturedTriangle's own comment there for what was tried and why it didn't help), and that a
 * finer mesh only shrinks it, never eliminates it. The remaining hypothesis: this is a Canvas2D
 * limitation specifically — it draws each mesh triangle as its own clip()+drawImage() call, with no
 * guarantee that two triangles sharing an edge get that edge filled seamlessly (each call's own
 * anti-aliasing/sampling is independent) — while a GPU rasterizer (what Aladin's own HiPS tiles go
 * through, via WebGL) fills every pixel of a triangle mesh exactly once by construction, with no
 * such gap possible between adjacent triangles sharing a vertex. This component renders the exact
 * same kind of mesh (same tangent-plane math, same per-vertex world2pix) through WebGL instead of
 * Canvas2D, so the two can be compared side by side on the same real footprint data. */

// --- Sky math, duplicated from SkyMapCard.tsx rather than exported from it, to keep this PoC's
// diff fully self-contained and trivial to delete later regardless of what happens to that file. ---

function gnomonicXiEta(raDeg: number, decDeg: number, ra0Deg: number, dec0Deg: number): [number, number] {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const ra = toRad(raDeg);
  const dec = toRad(decDeg);
  const ra0 = toRad(ra0Deg);
  const dec0 = toRad(dec0Deg);
  const cosc = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
  const xi = (Math.cos(dec) * Math.sin(ra - ra0)) / cosc;
  const eta = (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / cosc;
  return [toDeg(xi), toDeg(eta)];
}

function invGnomonic(xiDeg: number, etaDeg: number, ra0Deg: number, dec0Deg: number): [number, number] {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const xi = toRad(xiDeg);
  const eta = toRad(etaDeg);
  const ra0 = toRad(ra0Deg);
  const dec0 = toRad(dec0Deg);
  const rho = Math.hypot(xi, eta);
  if (rho === 0) return [ra0Deg, dec0Deg];
  const c = Math.atan(rho);
  const dec = Math.asin(Math.cos(c) * Math.sin(dec0) + (eta * Math.sin(c) * Math.cos(dec0)) / rho);
  const ra = ra0 + Math.atan2(xi * Math.sin(c), rho * Math.cos(dec0) * Math.cos(c) - eta * Math.sin(dec0) * Math.sin(c));
  return [((toDeg(ra) % 360) + 360) % 360, toDeg(dec)];
}

function tangentPlaneCenter(aDeg: [number, number], cDeg: [number, number]): [number, number] {
  const [xiA, etaA] = gnomonicXiEta(aDeg[0], aDeg[1], aDeg[0], aDeg[1]);
  const [xiC, etaC] = gnomonicXiEta(cDeg[0], cDeg[1], aDeg[0], aDeg[1]);
  return invGnomonic((xiA + xiC) / 2, (etaA + etaC) / 2, aDeg[0], aDeg[1]);
}

function fovCorners(
  centerRa: number, centerDec: number, widthDeg: number, heightDeg: number, paDeg: number, mirrored: boolean,
): [number, number][] {
  const paRad = (paDeg * Math.PI) / 180;
  const halfW = ((mirrored ? -1 : 1) * widthDeg) / 2;
  const halfH = heightDeg / 2;
  const offsets: [number, number][] = [[halfW, -halfH], [-halfW, -halfH], [-halfW, halfH], [halfW, halfH]];
  return offsets.map(([dx, dy]) => {
    const rx = dx * Math.cos(paRad) - dy * Math.sin(paRad);
    const ry = dx * Math.sin(paRad) + dy * Math.cos(paRad);
    return invGnomonic(rx, ry, centerRa, centerDec);
  });
}

/** Advanced-solve footprints (f.corners present) carry their real per-corner RA/Dec, so parity is
 * already correct; basic-solve ones need `mirrored: true` — see SkyMapCard.tsx's fovCorners for the
 * full story on why.
 *
 * Also applies the same `[a,b,c,d] => [c,d,a,b]` reorder SkyMapCard.tsx's own meshCorners applies to
 * this same fovCorners fallback (see its comment there for why fovCorners' corner winding needs it).
 * An earlier version of this file skipped the reorder, reasoning that `UNPACK_FLIP_Y_WEBGL` (see
 * loadTexture) already compensates for it — confirmed live, against real basic-solve photos, that
 * this was wrong: every image came out rotated 180°. Worked through the corner math by hand instead
 * of guessing again: tracking what image-left/image-top consistently map to in xi/eta space shows
 * the reorder is exactly what's needed on top of FLIP_Y_WEBGL, not in place of it — the two flip
 * different things (mesh winding vs. texture row order) and both are required. */
function footprintCorners(f: AstrobinFootprint): [number, number][] {
  if (f.corners) return f.corners;
  const [a, b, c, d] = fovCorners(f.ra!, f.dec!, f.widthDeg!, f.heightDeg!, f.orientationDeg!, true);
  return [c, d, a, b];
}

function angularSeparationDeg(ra1Deg: number, dec1Deg: number, ra2Deg: number, dec2Deg: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dPhi = toRad(dec2Deg - dec1Deg);
  const dLambda = toRad(ra2Deg - ra1Deg);
  const sinDPhi2 = Math.sin(dPhi / 2);
  const sinDLambda2 = Math.sin(dLambda / 2);
  const phi1 = toRad(dec1Deg);
  const phi2 = toRad(dec2Deg);
  const h = sinDPhi2 * sinDPhi2 + Math.cos(phi1) * Math.cos(phi2) * sinDLambda2 * sinDLambda2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h))) * 180) / Math.PI;
}

function footprintCenterAndRadiusDeg(f: AstrobinFootprint): { ra: number; dec: number; radiusDeg: number } {
  if (!f.corners) {
    return { ra: f.ra!, dec: f.dec!, radiusDeg: Math.hypot(f.widthDeg!, f.heightDeg!) / 2 };
  }
  const [ra0, dec0] = f.corners[0];
  let ra2 = f.corners[2][0];
  if (ra2 - ra0 > 180) ra2 -= 360;
  else if (ra0 - ra2 > 180) ra2 += 360;
  const dec2 = f.corners[2][1];
  return {
    ra: ((ra0 + ra2) / 2 + 360) % 360,
    dec: (dec0 + dec2) / 2,
    radiusDeg: angularSeparationDeg(ra0, dec0, f.corners[2][0], dec2) / 2,
  };
}

function safeWorld2Pix(aladin: any, ra: number, dec: number): [number, number] | null {
  try {
    return aladin.world2pix(ra, dec) ?? null;
  } catch {
    return null;
  }
}

// Cheap on the GPU regardless of size (unlike Canvas2D's clip()+drawImage() per triangle) — no
// need for SkyMapCard.tsx's adaptive/screen-size-based grid sizing here, a single fixed value is
// enough to demonstrate whether WebGL rasterization itself removes the seam Canvas2D shows.
const MESH_GRID_SIZE = 12;

const VERTEX_SHADER = `
  attribute vec2 aPosition;
  attribute vec2 aTexCoord;
  uniform vec2 uResolution;
  varying vec2 vTexCoord;
  void main() {
    vec2 clip = (aPosition / uResolution) * 2.0 - 1.0;
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
    vTexCoord = aTexCoord;
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;
  varying vec2 vTexCoord;
  uniform sampler2D uTexture;
  void main() {
    gl_FragColor = texture2D(uTexture, vTexCoord);
  }
`;

function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${info}`);
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram {
  const vs = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    throw new Error(`Program link failed: ${info}`);
  }
  return program;
}

/** Index buffer for an NxN cell grid ((N+1)x(N+1) vertices) is always the same regardless of where
 * those vertices actually project to on screen — built once, reused by every footprint and every
 * redraw. Same diagonal split as SkyMapCard.tsx's drawImageMesh (p00/p10/p01 and p10/p11/p01) so a
 * side-by-side comparison isn't also comparing two different triangulations. */
function buildIndices(gridSize: number): Uint16Array {
  const indices: number[] = [];
  const stride = gridSize + 1;
  for (let j = 0; j < gridSize; j++) {
    for (let i = 0; i < gridSize; i++) {
      const p00 = j * stride + i;
      const p10 = j * stride + (i + 1);
      const p01 = (j + 1) * stride + i;
      const p11 = (j + 1) * stride + (i + 1);
      indices.push(p00, p10, p01, p10, p11, p01);
    }
  }
  return new Uint16Array(indices);
}

/** Same (u,v) for every footprint (0..1 across the grid) regardless of where it projects to —
 * built once and reused, only the position buffer needs recomputing per redraw. u=i/N maps to
 * increasing source-image x (left to right); v=j/N to increasing source-image y (top to bottom) —
 * texture uploaded with UNPACK_FLIP_Y_WEBGL so v=0 lands on the image's own top row, matching that
 * directly without an extra flip here. */
function buildTexCoords(gridSize: number): Float32Array {
  const coords: number[] = [];
  const stride = gridSize + 1;
  for (let j = 0; j < stride; j++) {
    for (let i = 0; i < stride; i++) {
      coords.push(i / gridSize, j / gridSize);
    }
  }
  return new Float32Array(coords);
}

interface FootprintGpu {
  footprint: AstrobinFootprint;
  texture: WebGLTexture | null;
  textureReady: boolean;
  /** Null once per-vertex projection turns out degenerate (e.g. tangent-plane center undefined) —
   * skipped for the rest of that redraw rather than drawn with made-up positions. */
  positions: Float32Array;
}

async function loadTexture(gl: WebGLRenderingContext, url: string): Promise<WebGLTexture | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return texture;
}

export function SkyMapCard3D({
  dataSource,
  initialTarget,
  initialFovDeg,
}: {
  dataSource: SkyMapDataSource;
  initialTarget?: string;
  initialFovDeg?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const aladinRef = useRef<any>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const indexBufferRef = useRef<WebGLBuffer | null>(null);
  const texCoordBufferRef = useRef<WebGLBuffer | null>(null);
  const positionBufferRef = useRef<WebGLBuffer | null>(null);
  const indexCountRef = useRef(0);
  const footprintsRef = useRef<FootprintGpu[]>([]);
  // Populated by the redraw-loop effect below; called by the texture-loading effect once a
  // texture finishes decoding — otherwise a footprint whose thumbnail loads *after* the one draw()
  // call the initial (unchanging) fov/ra/dec produces would just never appear until the next real
  // pan/zoom happens to trigger the poll loop's own redraw.
  const drawRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState('loading Aladin…');
  // Lets a side-by-side comparison against the real (Canvas2D) footprint layer toggle this one
  // off entirely rather than the two always overlapping — mirrors SkyMapCard.tsx's own "My
  // AstroBin" toggle. A ref alongside the state since draw() (defined inside a ref-driven effect,
  // not re-run on every toggle) reads the *current* value each call rather than closing over
  // whatever it was when the effect last ran.
  const [showFootprints, setShowFootprints] = useState(true);
  const showFootprintsRef = useRef(true);

  // Aladin init — deliberately minimal (no catalogs/overlays/palette picker): this PoC only needs
  // a real HiPS background to check footprints against, not feature parity with SkyMapCard.tsx.
  useEffect(() => {
    if (!window.A || !containerRef.current) return;
    window.A.init.then(() => {
      if (aladinRef.current) return;
      // Aladin's own default P/DSS2/color pick has no CORS header on the browser fetch — see
      // publicDataSource.ts's own identical comment in astro-homepage — so this PoC goes through
      // whatever HiPS proxy the passed-in dataSource's own survey list points at instead, same as
      // SkyMapCard.tsx's buildImageSurvey does for a `custom` entry.
      const surveys = dataSource.getSurveys();
      const survey = surveys[0]?.custom
        ? window.A.imageHiPS(new URL(surveys[0].custom.url, window.location.origin).href, {
            name: surveys[0].label,
            cooFrame: surveys[0].custom.frame,
            maxOrder: surveys[0].custom.order,
            imgFormat: 'png',
          })
        : (surveys[0]?.builtin ?? 'P/DSS2/color');
      const aladin = window.A.aladin(containerRef.current, {
        survey,
        fov: initialFovDeg ?? 3,
        target: initialTarget ?? '0 0',
        cooFrame: 'equatorial',
        projection: 'SIN',
        showFullscreenControl: false,
        log: false,
      });
      aladinRef.current = aladin;
      // Ties our own redraw to the *exact* same tick as Aladin's own — its View class (reached via
      // the undocumented aladin.view, not part of Aladin Lite's public API, so this could break on
      // an Aladin upgrade) runs its own perpetual requestAnimationFrame loop that calls
      // drawAllOverlays() whenever `wasm.isRendering() || needRedraw` is true, right before
      // scheduling its own next frame. Wrapping that method — rather than polling fov/ra/dec in a
      // *separate* rAF loop, this component's first approach — means our footprint layer redraws
      // in the same frame Aladin redraws its own tiles/overlays, not up to one frame behind it, and
      // for free also catches cases fov/ra/dec polling never would (e.g. a HiPS tile fading in on
      // an otherwise-still view, where wasm.isRendering() is true but the view hasn't moved at all).
      const view = aladin.view;
      if (view && typeof view.drawAllOverlays === 'function') {
        const originalDrawAllOverlays = view.drawAllOverlays.bind(view);
        view.drawAllOverlays = (...args: unknown[]) => {
          originalDrawAllOverlays(...args);
          try {
            drawRef.current();
          } catch {
            // Ignored — same transient post-zoom WebGL state SkyMapCard.tsx's own poll loop
            // guards against (see its own comment); Aladin's redrawClbk calls this again next
            // frame regardless of what this wrapper does, so a bad frame here costs at most one
            // skipped footprint redraw, never wedges anything.
          }
        };
      }
      setStatus('loading footprints…');
    });
  }, [initialFovDeg, initialTarget, dataSource]);

  // WebGL canvas setup — sized to the container, resized whenever it changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const gl = canvas.getContext('webgl');
    if (!gl) {
      setStatus('WebGL not available in this browser');
      return;
    }
    glRef.current = gl;
    programRef.current = createProgram(gl);
    indexBufferRef.current = gl.createBuffer();
    texCoordBufferRef.current = gl.createBuffer();
    positionBufferRef.current = gl.createBuffer();

    const indices = buildIndices(MESH_GRID_SIZE);
    indexCountRef.current = indices.length;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBufferRef.current);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    const texCoords = buildTexCoords(MESH_GRID_SIZE);
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBufferRef.current);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Fetch footprints + kick off texture loads once the data source is available.
  useEffect(() => {
    let cancelled = false;
    dataSource.getAstrobinFootprints().then((footprints) => {
      if (cancelled) return;
      footprintsRef.current = footprints.map((footprint) => ({
        footprint, texture: null, textureReady: false, positions: new Float32Array(0),
      }));
      setStatus(`ready — ${footprints.length} footprints`);
      const gl = glRef.current;
      if (!gl || !footprints[0]?.thumbnailUrl) return;
      for (const entry of footprintsRef.current) {
        if (!entry.footprint.thumbnailUrl) continue;
        loadTexture(gl, entry.footprint.thumbnailUrl).then((texture) => {
          entry.texture = texture;
          entry.textureReady = texture !== null;
          drawRef.current();
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dataSource]);

  // draw() itself is called from two places, neither of them a self-scheduling loop of this
  // component's own: the drawAllOverlays hook (Aladin-init effect above) calls it every time
  // Aladin itself redraws, and the texture-loading effect below calls it once each thumbnail
  // finishes decoding (so a footprint whose texture arrives while the view is otherwise
  // completely idle — Aladin's own redrawClbk skips drawAllOverlays entirely when neither
  // wasm.isRendering() nor needRedraw is true — still appears without waiting for an actual
  // pan/zoom). An earlier version of this PoC instead ran its own separate requestAnimationFrame
  // polling loop (checking fov/ra/dec every frame, same approach as SkyMapCard.tsx's own) —
  // confirmed live that it visibly lagged Aladin's own redraw by roughly a frame during a drag,
  // being a fully independent loop with no ordering guarantee relative to Aladin's; piggybacking
  // on Aladin's own redraw call instead ties this to the exact same tick, not just the same rate.
  useEffect(() => {
    function draw() {
      const gl = glRef.current;
      const program = programRef.current;
      const aladin = aladinRef.current;
      if (!gl || !program || !aladin) return;
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!showFootprintsRef.current) return;
      gl.useProgram(program);
      gl.uniform2f(gl.getUniformLocation(program, 'uResolution'), gl.canvas.width, gl.canvas.height);

      const aPosition = gl.getAttribLocation(program, 'aPosition');
      const aTexCoord = gl.getAttribLocation(program, 'aTexCoord');
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBufferRef.current);
      gl.enableVertexAttribArray(aTexCoord);
      gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBufferRef.current);

      // Cheap pre-filter, same reasoning (and same AZIMUTHAL_PROJECTIONS radius cap) as
      // SkyMapCard.tsx's drawAstrobinFootprints: skips the ~169-world2pix-call full mesh below for
      // any footprint nowhere near the current view, which is what was making this PoC visibly lag
      // behind Aladin's own (separately, natively GPU-driven) redraw with dozens of footprints in
      // play — and, just as importantly, keeps a footprint from ever being handed to world2pix way
      // out past where an azimuthal projection (SIN here) stays well-behaved, which is the same
      // "renders somewhere it shouldn't, badly distorted" bug class the real mesh-bounding-span
      // guard (see SkyMapCard.tsx's meshBoundingSpan/maxSpanPx) exists to catch on the far side of.
      const AZIMUTHAL_PROJECTIONS_MAX_RADIUS_DEG = 105;
      const [viewRa, viewDec] = aladin.getRaDec();
      const [fovX, fovY] = aladin.getFov();
      const viewRadiusDeg = Math.min(AZIMUTHAL_PROJECTIONS_MAX_RADIUS_DEG, (Math.max(fovX, fovY) / 2) * 1.5 + 10);

      const stride = MESH_GRID_SIZE + 1;
      for (const entry of footprintsRef.current) {
        if (!entry.textureReady || !entry.texture) continue;
        const { ra: fRa, dec: fDec, radiusDeg: fRadiusDeg } = footprintCenterAndRadiusDeg(entry.footprint);
        if (angularSeparationDeg(viewRa, viewDec, fRa, fDec) > viewRadiusDeg + fRadiusDeg) continue;
        const corners = footprintCorners(entry.footprint);
        const [ra0, dec0] = tangentPlaneCenter(corners[0], corners[2]);
        if (!Number.isFinite(ra0) || !Number.isFinite(dec0)) continue;
        const [xiTL, etaTL] = gnomonicXiEta(corners[0][0], corners[0][1], ra0, dec0);
        const [xiTR, etaTR] = gnomonicXiEta(corners[1][0], corners[1][1], ra0, dec0);
        const [xiBR, etaBR] = gnomonicXiEta(corners[2][0], corners[2][1], ra0, dec0);
        const [xiBL, etaBL] = gnomonicXiEta(corners[3][0], corners[3][1], ra0, dec0);

        const positions = new Float32Array(stride * stride * 2);
        let anyOffscreen = false;
        for (let j = 0; j < stride; j++) {
          const v = j / MESH_GRID_SIZE;
          for (let i = 0; i < stride; i++) {
            const u = i / MESH_GRID_SIZE;
            const xi = xiTL * (1 - u) * (1 - v) + xiTR * u * (1 - v) + xiBR * u * v + xiBL * (1 - u) * v;
            const eta = etaTL * (1 - u) * (1 - v) + etaTR * u * (1 - v) + etaBR * u * v + etaBL * (1 - u) * v;
            const [ra, dec] = invGnomonic(xi, eta, ra0, dec0);
            const p = safeWorld2Pix(aladin, ra, dec);
            if (!p) {
              anyOffscreen = true;
              break;
            }
            const idx = (j * stride + i) * 2;
            positions[idx] = p[0];
            positions[idx + 1] = p[1];
          }
          if (anyOffscreen) break;
        }
        // A footprint with any unprojectable grid point is skipped entirely this frame, same
        // belt-and-suspenders reasoning as computeFootprintMesh returning null wholesale — this
        // PoC doesn't need the per-cell-hole tolerance the real component has.
        if (anyOffscreen) continue;

        gl.bindBuffer(gl.ARRAY_BUFFER, positionBufferRef.current);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(aPosition);
        gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, entry.texture);
        gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);

        gl.drawElements(gl.TRIANGLES, indexCountRef.current, gl.UNSIGNED_SHORT, 0);
      }
    }
    drawRef.current = draw;
  }, []);

  return (
    <div>
      <p style={{ fontSize: 12, opacity: 0.7 }}>{status}</p>
      <div ref={containerRef} style={{ position: 'relative', width: '100%', height: 500, background: '#000' }}>
        <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      </div>
      <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
        <input
          type="checkbox"
          checked={showFootprints}
          onChange={(e) => {
            showFootprintsRef.current = e.target.checked;
            setShowFootprints(e.target.checked);
            drawRef.current();
          }}
        />
        show footprints
      </label>
    </div>
  );
}
