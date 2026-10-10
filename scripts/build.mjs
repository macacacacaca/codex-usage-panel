import { stripTypeScriptTypes } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
await mkdir(new URL('dist/', root), { recursive: true });
for (const [source, target] of [['src/tokens.ts', 'dist/tokens.js'], ['src/domain.ts', 'dist/domain.js'], ['src/client.ts', 'dist/app.js']]) {
  const input = await readFile(new URL(source, root), 'utf8');
  const output = stripTypeScriptTypes(input, { mode: 'strip' }).replaceAll("'./domain.ts'", "'./domain.js'").replaceAll("'./tokens.ts'", "'./tokens.js'");
  await writeFile(new URL(target, root), output);
}
console.log('Browser files built.');
