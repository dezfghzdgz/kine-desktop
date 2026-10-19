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
//  KINE_SIGN=certum + KINE_SIGN_SHA1
//                          -> podpis certifikátem Certum (SimplySign) z úložiště
//                          Windows; obojí nastaví `node scripts/podpis.mjs priprav`
//                          po přihlášení (tajemství CERTUM_USERNAME, CERTUM_TOTP).
//                          Má přednost před Azure.
//  AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT, AZURE_SIGN_PROFILE, AZURE_SIGN_PUBLISHER
//                          -> podpis přes Azure Trusted Signing (k tomu
//                          AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
//                          bere electron-builder sám z prostředí)
//  KINE_HELPER_EXE=1       -> přibalit podepsaného pomocníka dist/helper/kine-helper.exe
//                          (taky z podpis.mjs; jen v podepsaném sestavení)
//
// S podpisem se podepisují i všechny .dll a .node (ffmpeg.dll, libEGL.dll…):
// Inteligentní řízení aplikací (Smart App Control) ve Windows pustí jen
// podepsaný kód, nestačí podepsat instalátor a Kine.exe.
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
    // Linux (AppImage, deb) a macOS (dmg + zip): pevné názvy, ať na ně web může odkazovat.
    linuxArtifact: 'Kine-Linux.${ext}',
    macArtifact: 'Kine-Mac.${ext}',
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
    linuxArtifact: 'Kine-Clipper-Linux.${ext}',
    macArtifact: 'Kine-Clipper-Mac.${ext}',
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
  const certumSha1 = (env.KINE_SIGN === 'certum' ? env.KINE_SIGN_SHA1 ?? '' : '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  const certum = certumSha1.length === 40;
  const azure = !certum && Boolean(sign.endpoint && sign.codeSigningAccountName && sign.certificateProfileName);
  const signing = azure || certum;
  const helperExe = signing && env.KINE_HELPER_EXE === '1';

  const lines = [
    'extends: ./electron-builder.yml',
    `appId: ${v.appId}`,
    `productName: ${JSON.stringify(v.productName)}`,
    // S podpisem: nepodepsaný soubor = chyba hned při sestavení, ne až při kontrole.
    ...(signing ? ['forceCodeSigning: true'] : []),
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
    // Kromě .exe i knihovny a nativní moduly (Smart App Control kontroluje každý načtený soubor).
    lines.push('  signExts:', '    - ".dll"', '    - ".node"');
  }
  if (certum) {
    // Aktualizace se podle jména v certifikátu neověřují: certifikát je na jméno
    // ("Open Source Developer, …") a s jiným (např. firemním) by pak už žádná
    // aktualizace neprošla. Stahuje se přes HTTPS a kontroluje sha512 z latest.yml.
    lines.push(
      '  verifyUpdateCodeSignature: false',
      '  signtoolOptions:',
      `    certificateSha1: ${JSON.stringify(certumSha1)}`,
      '    rfc3161TimeStampServer: "http://time.certum.pl"',
      '    signingHashAlgorithms:',
      '      - sha256',
      // Vlastní podpis s opakováním (cloud SimplySign občas zaváhá) - stejný signtool a parametry.
      '    sign: "./scripts/podpisHook.mjs"'
    );
  } else if (azure) {
    lines.push('  verifyUpdateCodeSignature: true', '  azureSignOptions:');
    for (const [k, val] of Object.entries(sign)) if (val) lines.push(`    ${k}: ${JSON.stringify(val)}`);
  }
  if (helperExe) {
    lines.push('extraResources:', '  - from: dist/helper', '    to: helper', '    filter:', '      - kine-helper.exe');
  }
  lines.push('nsis:', `  artifactName: ${JSON.stringify(v.artifact)}`, `  shortcutName: ${JSON.stringify(v.productName)}`);
  // Linux: AppImage (aktualizuje se sám přes electron-updater) + deb; macOS: dmg ke stažení a zip pro
  // aktualizace, univerzální (Intel i Apple Silicon). Bez podpisu Apple (identity: null) - viz README.
  lines.push(
    'linux:',
    `  icon: ${v.icon}`,
    `  artifactName: ${JSON.stringify(v.linuxArtifact)}`,
    `  executableName: ${JSON.stringify(v.name)}`,
    `  synopsis: ${JSON.stringify(variantKey === 'clipper' ? 'Clips from your games, uploaded to Kine' : 'Kine and clips from your games')}`,
    '  desktop:',
    '    entry:',
    `      Name: ${JSON.stringify(v.productName)}`,
    '      StartupWMClass: ' + JSON.stringify(v.name),
    'mac:',
    `  icon: ${v.icon}`,
    `  artifactName: ${JSON.stringify(v.macArtifact)}`,
    '  identity: null',
    '  hardenedRuntime: false',
    '  gatekeeperAssess: false',
    '  extendInfo:',
    '    NSCameraUsageDescription: "Camera in your clips and streams (only when you turn it on)."',
    '    NSMicrophoneUsageDescription: "Your voice in clips and streams (only when you turn it on)."',
    'dmg:',
    `  artifactName: ${JSON.stringify(v.macArtifact)}`,
    `  title: ${JSON.stringify(v.productName)}`
  );
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
  const signer = certum ? `Certum (${certumSha1})` : azure ? 'Azure Trusted Signing' : null;
  return { file: v.file, variant: variantKey, base, signing, signer, helperExe, text: lines.join('\n') + '\n' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = buildConfig();
  writeFileSync(cfg.file, cfg.text);
  console.log(
    `${cfg.file} (${cfg.variant}): aktualizace z ${cfg.base ? `${cfg.base}/${cfg.variant}` : 'GitHub Releases'}, podpis ${cfg.signer ?? 'žádný'}${cfg.helperExe ? ', s pomocníkem kine-helper.exe' : ''}`
  );
}
