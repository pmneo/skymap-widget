/** Runs at most `concurrency` tasks at once, queuing the rest until a slot frees up — e.g.
 *  `const limit = createConcurrencyLimiter(3); limit(() => fetch(url))`. AstroBin footprint
 *  thumbnails (see SkyMapCard's getAstrobinImage) used to load via plain `new Image().src = url`,
 *  which lets the browser fire one request per visible footprint at once — a gallery with a few
 *  dozen simultaneously-visible footprints could easily blow past the browser's 6-connections-
 *  per-origin limit on its own. */
export function createConcurrencyLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const run = queue.shift();
    run?.();
  }

  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task().then(
          (value) => {
            active--;
            resolve(value);
            next();
          },
          (err) => {
            active--;
            reject(err);
            next();
          },
        );
      });
      next();
    });
  };
}
