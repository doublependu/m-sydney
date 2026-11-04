// Where the map's files live under public/. A folder holds the tiles of one 8 km square, 64 at most, so no folder gets near the
// 1,000 files GitHub's website will list (tools/check-dist.mjs holds that). The game, the generators and the tests all name files here.

const FOLDER_TILES = 8; // tiles along each side of a folder's square

/** The folder of 1 km tile (ix, iz): "X_Z", for the 8 km square it's in */
const tileFolder = (ix, iz) => `${Math.floor(ix / FOLDER_TILES)}_${Math.floor(iz / FOLDER_TILES)}`;

/** A tile's file, from its key "ix_iz" and its hash, relative to tiles/ */
function tileFile(key, hash) {
  const [ix, iz] = key.split('_').map(Number);
  return `${tileFolder(ix, iz)}/${key}.${hash}.bin.gz`;
}

/** A far square's file, relative to tiles/ */
const farFile = (key, hash) => `far/far_${key}.${hash}.bin.gz`;

/** A map image, relative to map/: at 2 m a pixel there's one per tile, so those go in the tiles' folders */
const mapImageFile = (m, ix, iz) => (m === 2 ? `2/${tileFolder(ix, iz)}/${ix}_${iz}.webp` : `${m}/${ix}_${iz}.webp`);

export { FOLDER_TILES, farFile, mapImageFile, tileFile, tileFolder };
