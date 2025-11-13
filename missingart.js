// scripts/find-missing-art.js
import fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const root = process.cwd();
  const inPath  = path.join(root, 'catalog-Art.json');
  const outPath = path.join(root, 'missing-Art.json');

  let doc;
  try {
    const raw = await fs.readFile(inPath, 'utf8');
    doc = JSON.parse(raw);
  } catch (e) {
    console.error(`Failed to read/parse ${inPath}:`, e.message);
    process.exit(1);
  }

  const tracks = Array.isArray(doc) ? doc : Array.isArray(doc?.tracks) ? doc.tracks : [];
  if (!tracks.length) {
    console.log('No tracks found in catalog-Art.json');
    await fs.writeFile(outPath, '[]\n');
    return;
  }

  const hasArt = (t) => {
    const direct = typeof t?.artUrl === 'string' && t.artUrl.trim() !== '';
    const inTags = typeof t?.tags?.artUrl === 'string' && t.tags.artUrl.trim() !== '';
    return direct || inTags;
  };

  const missing = tracks.filter(t => !hasArt(t));

  await fs.writeFile(outPath, JSON.stringify(missing, null, 2) + '\n');

  console.log(`Tracks total: ${tracks.length}`);
  console.log(`Missing art:  ${missing.length}`);
  console.log(`Wrote:         ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
