# SkyMap features

An interactive, real-time sky map built on **Aladin Lite v3**, with:

## Sky surveys

- SHO and HSO narrowband palette HiPS, channel-remapped server-side from SIMG's OHS HiPS Northern
  Sky Survey (`simg.de`'s `ohs8` composite)
- DSS2 (color/red) and 2MASS (color), proxied and cached through the consuming site's own backend
  rather than fetched directly from CDS (sidesteps a CORS gap in Aladin's own default survey pick)
- Quick palette picker to switch between them, remembered across reloads

## AstroBin gallery footprints

- Footprints aligned on the map from real astrometry — either the image's actual per-corner
  plate-solve (Advanced Plate Solving) or a reconstructed rectangle from RA/Dec/width/height/
  orientation for images without it, correctly mirror-corrected either way
- Rendered via WebGL (a warped, GPU-rasterized mesh per footprint) instead of flat rectangles, so
  each thumbnail follows the sky's actual curvature at wide fields — matches how Aladin renders its
  own HiPS tiles, with none of the seam artifacts a Canvas2D approach would show
- Each footprint can be hidden individually (small gear button, dashed outline while hidden)
  without losing the rest of the gallery
- Click any footprint for a popover: title, acquisition date, link to the image on AstroBin,
  hide/show toggle
- Loading progress bar covering both the footprint list fetch and thumbnail loading
- Thumbnail loading is concurrency-limited and proxied through the consuming site's own backend
  (avoids CORS and the browser's per-origin connection cap)

## Live observatory tracking

(When connected to the mount/camera control session.)

- Live mount-position marker
- Live camera field-of-view rectangle, computed from actual sensor size, pixel size, and focal
  length
- "Follow mount" — keeps the view centered on the mount as it slews/tracks
- Last captured image overlaid directly on its own FOV rectangle, with stretch settings applied

## Framing planning

- A separate, independently-positionable "Planning FOV" rectangle — sized from sensor
  width/height, pixel size, and focal length, with its own rotation control
- Can be locked to a fixed sky position instead of following the current view
- SIMBAD cone search for nebulae/remnants/clusters inside the planning rectangle, with
  object-type labels and one-click "center on this object"
- One-click AstroBin coordinate search (RA/Dec/radius deep link) for any found object
- Altitude-vs-time visibility chart for the planning target, accounting for the real horizon

## Horizon & terrain

- Flat geometric horizon line plus configurable artificial-horizon regions (real obstructions —
  trees, roofline, etc.)
- 360° terrain photo panorama, reprojected live onto the sky view from the observatory's actual
  lat/lon
- Simulated time control ("Simulate at" / "Now") — horizon, terrain, and visibility all recompute
  for whatever time is set, not just the live moment

## Zenith lock

- Continuously rotates the view to keep zenith straight up (parallactic-angle correction) instead
  of the default celestial-north-up, so the sky's real drift during a session stays legible

## Catalogs & overlays

- NGC/IC and Sharpless (Sh2) catalogs
- Constellation lines and constellation boundaries
- Equatorial coordinate grid
- Open scheduler targets (jobs not yet completed) shown as markers

## Location & persistence

- Browser geolocation button, or manual lat/lon entry
- Last view (position, zoom, projection) restored automatically on reload
- Aladin's own projection switch (SIN/AIT/MOL/...) and coordinate search box, both
  persisted/available as usual

## Misc

- Fullscreen mode
