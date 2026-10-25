import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
function check(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory() && !['node_modules', 'data'].includes(entry.name)) check(file);
    else if (entry.isFile() && /\.(?:m?js)$/.test(file) && !file.includes('vendor')) {
      if (spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' }).status !== 0) process.exit(1);
    }
  }
}
for (const dir of ['backend', 'scripts', 'site/scripts', 'site/design-system']) check(dir);
