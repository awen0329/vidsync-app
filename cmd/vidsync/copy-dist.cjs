// Copies the vite build output from ../../frontend/dist into ./frontend-dist
// so that //go:embed all:frontend-dist in main.go has fresh assets to
// bake into vidsync.exe. Invoked by wails.json's frontend:build step
// (after `npm run build`). Source of truth is frontend/dist; this is
// just a build-time mirror, gitignored.
//
// Stand-alone Node so it's portable across shells — chaining via &&
// in wails.json proved fragile on Windows quoting.

const fs = require("node:fs");
const path = require("node:path");

const src = path.resolve(__dirname, "..", "..", "frontend", "dist");
const dst = path.resolve(__dirname, "frontend-dist");

if (!fs.existsSync(src)) {
  console.error(`copy-dist: source ${src} does not exist; run vite build first`);
  process.exit(1);
}

// Wipe dst contents but keep the directory itself (preserves .gitkeep
// and avoids racing with anything watching the dir).
for (const entry of fs.readdirSync(dst)) {
  if (entry === ".gitkeep") continue;
  fs.rmSync(path.join(dst, entry), { recursive: true, force: true });
}

fs.cpSync(src, dst, { recursive: true });
console.log(`copy-dist: ${src} -> ${dst}`);
