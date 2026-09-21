// Vygeneruje electron-builder.generated.yml podle toho, co je v prostředí
// (GitHub Actions secrets / variables). Základ je electron-builder.yml.
//
//  DESKTOP_DOWNLOAD_BASE   veřejná adresa složky s instalátorem (Cloudflare R2,
//                          např. https://pub-xxxx.r2.dev nebo https://stahnout.kine.cz)
//                          -> aktualizace se berou odsud ("generic"), GitHub
//                          Releases zůstávají jako záloha
//  AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT, AZURE_SIGN_PROFILE, AZURE_SIGN_PUBLISHER
//                          -> podpis přes Azure Trusted Signing (k tomu
//                          AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
//                          bere electron-builder sám z prostředí)
import { writeFileSync } from 'node:fs';

const OWNER = 'dezfghzdgz';
const REPO = 'kine-desktop';

const base = (process.env.DESKTOP_DOWNLOAD_BASE ?? '').trim().replace(/\/+$/, '');
const sign = {
  endpoint: process.env.AZURE_SIGN_ENDPOINT?.trim(),
  codeSigningAccountName: process.env.AZURE_SIGN_ACCOUNT?.trim(),
  certificateProfileName: process.env.AZURE_SIGN_PROFILE?.trim(),
  publisherName: process.env.AZURE_SIGN_PUBLISHER?.trim(),
};
const signing = Boolean(sign.endpoint && sign.codeSigningAccountName && sign.certificateProfileName);

const lines = ['extends: ./electron-builder.yml', 'publish:'];
if (base) {
  lines.push('  - provider: generic', `    url: ${JSON.stringify(base)}`, '    channel: latest');
}
lines.push('  - provider: github', `    owner: ${OWNER}`, `    repo: ${REPO}`, '    releaseType: release');

if (signing) {
  lines.push('win:', '  verifyUpdateCodeSignature: true', '  azureSignOptions:');
  for (const [k, v] of Object.entries(sign)) if (v) lines.push(`    ${k}: ${JSON.stringify(v)}`);
}

writeFileSync('electron-builder.generated.yml', lines.join('\n') + '\n');
console.log(`electron-builder.generated.yml: aktualizace z ${base || 'GitHub Releases'}, podpis ${signing ? 'Azure Trusted Signing' : 'žádný'}`);
