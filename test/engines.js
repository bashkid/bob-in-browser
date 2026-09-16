import * as B from '../browser.js';
import path from 'node:path';
const url = 'file://' + path.resolve('test/broken.html');
for (const eng of ['chromium', 'firefox', 'webkit']) {
  try {
    const r = await B.openPage(url, { width: 390, engine: eng });
    const a = await B.audit({ width: 390 });
    const s = await B.shoot({ width: 390, label: eng });
    console.log(`${eng.padEnd(9)} mode=${r.mode.padEnd(26)} issues=${a.total_issues} ${JSON.stringify(a.counts)} shot=${s.base64.length>1000?'ok':'FAIL'}`);
  } catch (e) {
    console.log(`${eng.padEnd(9)} FAILED: ${e.message.split('\n')[0]}`);
  }
}
await B.closeBrowser();
