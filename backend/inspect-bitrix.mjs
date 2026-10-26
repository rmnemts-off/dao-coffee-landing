import { inspectBitrix } from './bitrix.mjs';

try {
  // Only configuration metadata. No customer list, raw errors or webhook URL.
  console.log(JSON.stringify(await inspectBitrix({ webhookUrl: process.env.BITRIX_WEBHOOK_URL }), null, 2));
} catch {
  console.error('Bitrix inspection failed. Check BITRIX_WEBHOOK_URL, REST access and CRM permissions; see backend/README.md.');
  process.exitCode = 1;
}
