# skymap-widget

`SkyMapCard` — an Aladin Lite-based sky map (AstroBin footprints, NGC/Sh2 catalogs, constellation
lines/bounds, a mount/scheduler-aware live overlay) — extracted so it can be shared, unmodified,
between KStarsCluster's live dashboard and any other site that wants the same widget.

Ships raw TypeScript/TSX (no build step) — consuming bundlers compile it themselves:

- **Vite** (KStarsCluster's own dashboard): works out of the box.
- **Next.js**: add `transpilePackages: ["skymap-widget"]` to `next.config.ts`.

## Using it

Everything deployment-specific (where AstroBin footprints/observatory info/scheduler jobs come
from) is injected via a `SkyMapDataSource` you implement — see `src/dataSource.ts` for the full
interface, and KStarsCluster's own `liveDataSource.ts` / astro-homepage's `publicDataSource.ts` for
two real implementations.

```tsx
import { SkyMapCard, type SkyMapDataSource } from "skymap-widget";
import "skymap-widget/SkyMap.css";

const dataSource: SkyMapDataSource = { /* ... */ };

<SkyMapCard dataSource={dataSource} activeJob={null} />
```

Requires the Aladin Lite v3 script (`window.A`) to already be loaded before `SkyMapCard` mounts —
its own init effect doesn't wait/retry for it.

Also needs `public/constellations/lines.json` and `bounds.json` (constellation stick-figure lines
and IAU boundary polygons) present in the consuming app's own static assets — not bundled into this
package since they're plain static files, not code.

## Depending on this package locally

Not published to a registry — consumed via a `file:` dependency pointing at this checkout, e.g.:

```json
"dependencies": {
  "skymap-widget": "file:../skymap-widget"
}
```

After changing anything here, run `npm install` again in each consuming app to pick it up (a
`file:` dependency is copied/symlinked at install time, not watched live).
