// Vygeneruje konfiguraci electron-builderu pro jednu ze dvou appek podle
// toho, co je v prostředí (GitHub Actions secrets / variables). Základ je
// electron-builder.yml (appka "Kine"); druhá appka "Kine Clipper" se od
// něj liší názvem, ikonou, appId, názvem instalátoru a složkou
// s aktualizacemi.
//
//  KINE_VARIANT            full (výchozí) -> electron-builder.generated.yml, appka "Kine"
//                          clipper        -> electron-builder.clipper.yml,   appka "Kine Clipper"
//  DESKTOP_DOWNLOAD_BASE   veřejná adresa složky s instalátory (Cloudflare R2,
//                          např. https://pub-xxxx.r2.dev nebo https://stahnout.kine.cz)
//                          -> aktualizace se berou z <BASE>/full/ resp. <BASE>/clipper/
//                          ("generic"), GitHub Releases zůstávají jako záloha
//  AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT, AZURE_SIGN_PROFILE, AZURE_SIGN_PUBLISHER
//                          -> podpis přes Azure Trusted Signing (k tomu
//                          AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
//                          bere electron-builder sám z prostředí)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OWNER = 'dezfghzdgz';
const REPO = 'kine-desktop';

export const VARIANTS = {
  full: {
    file: 'electron-builder.generated.yml',
    productName: 'Kine',
    name: 'kine-desktop',
    appId: 'cz.kine.desktop',
    artifact: 'Kine-Setup.${ext}',
    icon: 'build/icon.png',
    output: 'release/full',
    folder: 'full',
  },
  clipper: {
    file: 'electron-builder.clipper.yml',
    productName: 'Kine Clipper',
    name: 'kine-clipper',
    appId: 'cz.kine.clipper',
    artifact: 'Kine-Clipper-Setup.${ext}',
    icon: 'build/icon-clipper.png',
    output: 'release/clipper',
    folder: 'clipper',
  },
};

export function buildConfig(env = process.env) {
  const variantKey = env.KINE_VARIANT === 'clipper' ? 'clipper' : 'full';
  const v = VARIANTS[variantKey];
  const base = (env.DESKTOP_DOWNLOAD_BASE ?? '').trim().replace(/\/+$/, '');
  const sign = {
    endpoint: env.AZURE_SIGN_ENDPOINT?.trim(),
    codeSigningAccountName: env.AZURE_SIGN_ACCOUNT?.trim(),
    certificateProfileName: env.AZURE_SIGN_PROFILE?.trim(),
    publisherName: env.AZURE_SIGN_PUBLISHER?.trim(),
  };
  const signing = Boolean(sign.endpoint && sign.codeSigningAccountName && sign.certificateProfileName);

  const lines = [
    'extends: ./electron-builder.yml',
    `appId: ${v.appId}`,
    `productName: ${JSON.stringify(v.productName)}`,
    'directories:',
    `  output: ${v.output}`,
    '  buildResources: build',
    // Do package.json zabalené appky: podle kineVariant appka pozná, která je
    // (src/main/variant.ts); name určuje složku s daty (každá appka svou).
    'extraMetadata:',
    `  name: ${v.name}`,
    `  productName: ${JSON.stringify(v.productName)}`,
    `  kineVariant: ${variantKey}`,
    'win:',
    `  icon: ${v.icon}`,
    `  artifactName: ${JSON.stringify(v.artifact)}`,
  ];
  if (signing) {
    lines.push('  verifyUpdateCodeSignature: true', '  azureSignOptions:');
    for (const [k, val] of Object.entries(sign)) if (val) lines.push(`    ${k}: ${JSON.stringify(val)}`);
  }
  lines.push('nsis:', `  artifactName: ${JSON.stringify(v.artifact)}`, `  shortcutName: ${JSON.stringify(v.productName)}`);
  lines.push('publish:');
  if (base) {
    // První poskytovatel = odkud si appka bere aktualizace (app-update.yml).
    lines.push('  - provider: generic', `    url: ${JSON.stringify(`${base}/${v.folder}`)}`, '    channel: latest');
  }
  lines.push('  - provider: github', `    owner: ${OWNER}`, `    repo: ${REPO}`, '    releaseType: release');
  if (variantKey === 'clipper') {
    // Na GitHubu leží obě appky v jednom vydání - ať si nepřepisují latest.yml.
    lines.push('    channel: clipper');
  }
  return { file: v.file, variant: variantKey, base, signing, text: lines.join('\n') + '\n' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = buildConfig();
  writeFileSync(cfg.file, cfg.text);
  console.log(`${cfg.file} (${cfg.variant}): aktualizace z ${cfg.base ? `${cfg.base}/${cfg.variant}` : 'GitHub Releases'}, podpis ${cfg.signing ? 'Azure Trusted Signing' : 'žádný'}`);
}
