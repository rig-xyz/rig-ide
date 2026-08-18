import type { Configuration } from 'electron-builder';
import {
  APP_ID,
  ARTIFACT_PREFIX,
  PRODUCT_NAME,
  R2_BASE_URL,
  UPDATE_CHANNEL,
} from './src/shared/app-identity.ts';

const config: Configuration = {
  appId: APP_ID,
  productName: PRODUCT_NAME,
  executableName: PRODUCT_NAME,
  directories: { output: 'release' },
  // Version in the filename so every release is a distinct URL. Without it,
  // each release overwrites the previous object and the CDN keeps serving the
  // old bytes from cache until the TTL expires — a stale download that looks
  // like a successful one.
  artifactName: `${ARTIFACT_PREFIX}-\${version}-\${arch}.\${ext}`,
  // Upstream published to generalaction/emdash's GitHub releases — running a
  // publish with that block intact would try to draft releases on THEIR repo.
  // We publish by uploading the release/ artifacts (dmg, zip, latest-mac.yml)
  // to our R2 bucket behind R2_BASE_URL; the generic provider below is what
  // electron-updater reads at runtime. If publishing ever moves into CI, add an
  // s3-provider block pointed at the R2 endpoint — never a github one.
  publish: [
    {
      provider: 'generic',
      url: R2_BASE_URL,
      channel: UPDATE_CHANNEL,
    },
  ],
  generateUpdatesFilesForAllChannels: false,
  files: ['out/**/*', 'node_modules/**/*', 'drizzle/**/*'],
  // Bundled @rigxyz/cli — produced by scripts/vendor-rig-cli.ts (run automatically
  // by the package:* scripts and scripts/release/build.ts). Lives OUTSIDE the asar
  // because the rig/tapd shims are exec'd by the OS (shebang + execve need real
  // files). Lands in Contents/Resources/{rig-cli,rig-bin}; the shims in rig-bin
  // locate the app executable by globbing Contents/MacOS, so they do not depend
  // on productName above.
  //
  // The separate node_modules entry is NOT redundant: electron-builder's copy
  // filter (app-builder-lib util/filter.js createFilter) silently drops a
  // top-level `node_modules` directory relative to each entry's `from`, so the
  // rig-cli entry alone ships the CLI without its deps. Pointing `from` at the
  // node_modules dir itself sidesteps that special case. (Nested node_modules
  // would still be dropped — scripts/vendor-rig-cli.ts fails the build if the
  // vendored tree ever contains one.)
  extraResources: [
    { from: 'vendor/rig-cli', to: 'rig-cli' },
    { from: 'vendor/rig-cli/node_modules', to: 'rig-cli/node_modules' },
    { from: 'vendor/rig-bin', to: 'rig-bin' },
  ],
  asarUnpack: [
    'node_modules/better-sqlite3/**',
    'node_modules/node-pty/**',
    'node_modules/@parcel/watcher/**',
    '**/*.node',
  ],
  mac: {
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // Round (first-launch prompts): NO `extendInfo` here on purpose — rig
    // ships no voice/mic feature (inherited emdash boilerplate used to
    // declare `NSMicrophoneUsageDescription`, which is what let
    // `main/index.ts` ask for mic access on every cold boot). Without the
    // usage description, the app cannot ask for mic access at all, even by
    // accident — see `build/entitlements.mac.plist`'s matching removal.
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    icon: 'src/assets/images/rig/rig.icns',
    // Signing picks the 'Developer ID Application' identity from the keychain
    // automatically. Notarization reads APPLE_API_KEY (path to the .p8),
    // APPLE_API_KEY_ID and APPLE_API_ISSUER from the environment at package
    // time — credentials live with the operator, never in the repo.
    notarize: true,
  },
  dmg: {
    icon: 'src/assets/images/rig/rig.icns',
    background: 'build/dmg-background.tiff',
    window: { width: 530, height: 319 },
    contents: [
      { x: 132, y: 150, type: 'file' },
      { x: 398, y: 150, type: 'link', path: '/Applications' },
    ],
  },
  linux: {
    category: 'Development',
    icon: 'src/assets/images/rig/rig.png',
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
      { target: 'rpm', arch: ['x64'] },
    ],
  },
  win: {
    icon: 'src/assets/images/rig/rig.png',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'msi', arch: ['x64'] },
    ],
    // Windows builds are unsigned until we have our own signing identity —
    // upstream's azureSignOptions (General Action's Azure Trusted Signing
    // account) was removed with the rest of their release identity.
  },
  msi: {
    oneClick: false,
    perMachine: false,
  },
  nsis: {
    differentialPackage: true,
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },
  npmRebuild: false,
  // Encrypt Chromium's on-disk cookie store (in-app browser logins) with OS-level
  // keys, like Chrome does. One-way: never disable once shipped or existing
  // cookie stores become unreadable.
  electronFuses: {
    enableCookieEncryption: true,
  },
};

export default config;
