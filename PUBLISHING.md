# Release pi-doom-hud

Run this after making and committing changes.

```bash
cd ~/Code/misc/pi-doom-hud

git status --short                    # must be clean after your change commit
npm ci --no-audit --no-fund
npm run typecheck
npm test
git diff --check
npm pack --dry-run                   # verify the published file list

npm version patch                    # use minor or major when appropriate
git push origin main --follow-tags
npm publish --access public
npm view pi-doom-hud version keywords
```

Update `CHANGELOG.md` before `npm version`. Keep the `pi-package` keyword in
`package.json`; it is required for the pi.dev package gallery.

After publishing, verify installation:

```bash
pi install npm:pi-doom-hud
pi list
```

For a new terminal or OS image-face confirmation, run `/doomhud image`, check
that the face redraws correctly, then run `/doomhud text` to verify the fallback.
Update the README matrix only after a real visual check.
