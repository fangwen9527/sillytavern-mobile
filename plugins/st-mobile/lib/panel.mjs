import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PANEL_FILE = path.join(here, '..', 'public', 'panel.html');

let cached = null;

export function renderPanel() {
  if (cached === null) cached = fs.readFileSync(PANEL_FILE, 'utf8');
  return cached;
}
