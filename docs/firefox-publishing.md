# Publishing the Firefox Client

This guide covers publishing `firefox/` as a signed Firefox add-on through Mozilla Add-ons (AMO). The OMP plugin, VS Code extension, and native host are separate artifacts and follow their own release paths.

Official references:

- [AMO signing and distribution overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- [Submitting an add-on](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)
- [`web-ext` command reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
- [Firefox native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)

## Release boundary

- `firefox/manifest.json` and `firefox/package.json` carry the Firefox client version.
- `firefox/native-host/package.json` carries the Linux Firefox native messaging host version.
- `package.json` and `package-lock.json` carry the VS Code/OMP package version.
- `firefox/manifest.json` contains the stable extension ID `omp-send-context@klondikemarlen.github.io`.
- The Linux Firefox native messaging host manifest must allowlist that exact extension ID. Never change the ID casually; an ID change requires a coordinated host manifest update and a new AMO installation path.
- The Linux native messaging host is not uploaded to AMO. It is installed through the operating system and documented separately.

## Before publishing

1. Create a GitHub issue and issue-named branch.
2. Implement the client and open a pull request against `main`.
3. Install dependencies and run the reproducible checks:

   ```bash
   npm install
   npm test
   npx web-ext lint --source-dir firefox --ignore-files 'native-host/**' 'native-host/'
   ```

4. Run the [Firefox Manual QA](firefox-manual-qa.md) flow in a fresh Firefox profile. Test cases 1, 2, and 4 must be **PASS**.
5. Review the packaged source. Do not include credentials, local bridge state, test fixtures, or the native host in the Firefox add-on artifact.
6. Confirm the manifest's `browser_specific_settings.gecko.id`, minimum Firefox version, permissions, host scope, and `data_collection_permissions` are intentional.
7. Merge the implementation pull request only after review, automated checks, and interactive QA are complete.

## Build the AMO upload artifact

From the release checkout:

```bash
npm install
npm run package:firefox
```

The command cleans `dist/firefox`, builds one unsigned ZIP, and prints its path and SHA-256. Upload that printed ZIP to the AMO submission form. The generated ZIP is disposable; do not commit it unless the repository release policy explicitly requires checked-in artifacts.

## Signed pre-release validation

To avoid `about:debugging` without exposing an untested add-on to normal users, submit the same artifact through AMO as **unlisted** first. Install the signed XPI in a fresh Firefox profile and run the manual QA flow. This signs the add-on for normal Firefox installation but does not create a public listing.

With AMO API credentials configured locally:

```bash
npx web-ext sign \
  --source-dir firefox \
  --artifacts-dir dist/firefox \
  --channel unlisted
```

Do not submit the listed release until the signed XPI passes manual QA.


## Submit through AMO

1. Sign in to the [AMO Developer Hub](https://addons.mozilla.org/developers/).
2. Choose **Submit a New Add-on** for the first release, or open the existing add-on for a new version.
3. Upload the artifact from `dist/firefox/`.
4. Complete the listing metadata, support URL, privacy/data-collection declarations, and source-code submission requested by AMO.
5. Keep the stable extension ID unchanged.
6. Submit for signing/review. Record the AMO add-on URL and submitted version in the release record.

For repeatable command-line submission, configure the AMO API credentials through a local secret manager or ignored shell environment variables. Use the names below in `.envrc`; they are local aliases, not AMO-required variable names:

```bash
export AMO_API_KEY='your-AMO-issuer'
export AMO_API_SECRET='your-AMO-secret'
```

Submit the listed add-on with:

```bash
npx web-ext sign \
  --source-dir firefox \
  --artifacts-dir dist/firefox \
  --ignore-files 'native-host/**' 'native-host/' \
  --api-key "$AMO_API_KEY" \
  --api-secret "$AMO_API_SECRET" \
  --channel listed
```

Do not paste credentials into issue, pull-request, or release notes. If AMO requires human review, the release remains pending until AMO reports the signed/public result.

## Post-publish verification

1. Poll the AMO listing until the new version is visible.
2. In a fresh Firefox profile, install the published AMO add-on rather than the temporary checkout.
3. Confirm **about:addons** shows the expected extension name and version.
4. Install the matching Linux Firefox native messaging host and verify its manifest still allowlists the stable extension ID.
5. Start a fresh OMP process and run Firefox Manual QA test cases 1, 2, and 4.
6. Confirm the clipboard fallback path still works by temporarily making the Linux Firefox native messaging host unavailable.
7. Record the AMO URL, visible version, Firefox version, OMP version, Linux native-host version, and PASS/FAIL/BLOCKED results.

## Rollback

If the published add-on is defective:

1. Disable or unpublish the affected AMO version according to AMO’s current controls.
2. Restore the last known-good native host and OMP plugin versions.
3. Open a corrective issue and release a higher Firefox version; do not reuse the published version number.
4. Repeat linting, fresh-profile installation, and the manual QA flow before republishing.
