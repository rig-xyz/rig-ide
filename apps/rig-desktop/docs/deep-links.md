# rig:// deep links

The desktop app registers the `rig` URL scheme. The website depends on one
link shape, so this doc is the contract between the two.

## `rig://join/<secret>`

The website's invite page (`https://userig.xyz/join/<secret>`) offers "Open in
Rig", which opens `rig://join/<secret>` with the same secret.

- `<secret>` is the invite secret exactly as the relay minted it:
  `tap_inv_` followed by 16–128 base64url characters (`A–Z a–z 0–9 _ -`). Put
  it in the link as-is, with no percent-encoding.
- An optional trailing slash is allowed. Nothing else is accepted: no query
  string, no fragment, no extra path segments. The app ignores any other
  `rig://` URL and logs only "ignored deep link".
- The scheme and the `join` host are case-insensitive. The secret is
  case-sensitive.

What the app does with it:

1. It brings its window to the front and shows a confirm: "Join #space?",
   plus "Invited by name" when the relay's public preview
   (`GET /v1/invites/:secret`) includes a name. Opening the link never joins
   anything by itself, because any web page can open a `rig://` URL.
2. **Join** accepts the invite (`POST /v1/invites/:secret/accept`), sets up
   the space locally, and opens it. This is the same flow as pasting the
   `https://userig.xyz/join/<secret>` link into Home. **Not now** closes the
   confirm and leaves the invite untouched.
3. If the invite is expired, revoked, already used or unknown, the confirm
   says so and can only be dismissed. If the user isn't signed in, the confirm
   offers the app's own sign-in and carries on with the join once sign-in
   finishes.

The app never logs the secret or the URL that carries it.

## Where it lives

- Parser and contract: `src/shared/rig/deep-link.ts`. The secret shape is
  `isInviteSecretShape` in `src/shared/rig/invite-link.ts`.
- OS plumbing: `src/main/app/deep-links.ts`. It handles macOS `open-url`
  (including on a cold launch), Windows/Linux `second-instance` argv, and the
  initial `process.argv`. Links wait in `src/main/rig/deep-link-inbox.ts`
  until the renderer's confirm has mounted.
- Confirm UI: `src/renderer/features/deep-link/deep-link-join-dialog.tsx`.
- Scheme declaration: `protocols` in `electron-builder.config.ts` (and the
  canary config).

## Testing a link

macOS routes a scheme only to an app bundle whose Info.plist declares it, so
test on a packaged build (`/Applications/Rig.app`): run
`open 'rig://join/tap_inv_…'` in Terminal, or click "Open in Rig" on the
invite page. On macOS, `pnpm dev` doesn't register the scheme at all:
registering the bare Electron.app would only take the default away from an
installed Rig.app. On Windows and Linux, `pnpm dev` registers the Electron
binary plus the app path. The single-instance lock is off in dev, though, so
a link there starts a second dev instance instead of reaching the running
one.
