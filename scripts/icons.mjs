import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const svg = readFileSync("public/icons/icon.svg", "utf8");
const b = await chromium.launch();
for (const s of [16, 32, 48, 128]) {
  const p = await b.newPage({ viewport: { width: s, height: s } });
  await p.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${s}px;height:${s}px;display:block}</style>${svg}`);
  await p.screenshot({ path: `public/icons/icon-${s}.png`, omitBackground: true });
}
await b.close();
