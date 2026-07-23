# Publishing the Firefox Client

This guide covers publishing `firefox/` as a signed Firefox add-on through Mozilla Add-ons (AMO). The OMP plugin, VS Code extension, and native host are separate artifacts and follow their own release paths.

Official references:

- [AMO signing and distribution overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- [Submitting an add-on](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)
- [`web-ext` command reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
- [Firefox native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)

## Release boundary

- `firefox/manifest.json` and `firefox/package.json` carry the Firefox client version.
- `native-host/package.json` carries the native-host version.
- `package.json` and `package-lock.json` carry the VS Code/OMP package version.
- `firefox/manifest.json` contains the stable extension ID `omp-send-context@klondikemarlen.github.io`.
- The native-host manifest must allowlist that exact extension ID. Never change the ID casually; an ID change requires a coordinated native-host manifest update and a new AMO installation path.
- The native host is not uploaded to AMO. It is installed through the operating system and documented separately.

## Before publishing

1. Create a GitHub issue and issue-named branch.
2. Implement the client and open a pull request against `main`.
3. Run the repository checks:

   ```bash
   npm install
   npm test
   npm run package:vsix
   npx web-ext lint --source-dir firefox
   ```

4. Run the [Firefox Manual QA](firefox-manual-qa.md) flow in a fresh Firefox profile. Test cases 1, 2, and 4 must be **PASS**.
5. Review the packaged source. Do not include credentials, local bridge state, test fixtures, or the native host in the Firefox add-on artifact.
6. Confirm the manifest's `browser_specific_settings.gecko.id`, minimum Firefox version, permissions, host scope, and `data_collection_permissions` are intentional.
7. Merge the implementation pull request only after review, automated checks, and interactive QA are complete.

## Build the unsigned artifact

From the merged release checkout:

```bash
rm -rf dist/firefox
mkdir -p dist/firefox
npx web-ext build --source-dir firefox --artifacts-dir dist/firefox
unzip -l dist/firefox/*.zip
```

`web-ext build` creates the upload artifact. The generated ZIP/XPI is disposable; do not commit it unless the repository release policy explicitly requires checked-in artifacts.

## Submit through AMO

1. Sign in to the [AMO Developer Hub](https://addons.mozilla.org/developers/).
2. Choose **Submit a New Add-on** for the first release, or open the existing add-on for a new version.
3. Upload the artifact from `dist/firefox/`.
4. Complete the listing metadata, support URL, privacy/data-collection declarations, and source-code submission requested by AMO.
5. Keep the stable extension ID unchanged.
6. Submit for signing/review. Record the AMO add-on URL and submitted version in the release record.

For repeatable command-line submission, configure AMO API credentials through a local secret manager or ignored shell environment variables. Never commit them or create an environment example file:

```bash
export WEB_EXT_API_KEY='your-local-amo-api-key'
export WEB_EXT_API_SECRET='your-local-amo-api-secret'
npx web-ext sign \
  --source-dir firefox \
  --artifacts-dir dist/firefox \
  --channel listed
```

Do not paste credentials into issue, pull-request, or release notes. If AMO requires human review, the release remains pending until AMO reports the signed/public result.

## Post-publish verification

1. Poll the AMO listing until the new version is visible.
2. In a fresh Firefox profile, install the published AMO add-on rather than the temporary checkout.
3. Confirm **about:addons** shows the expected extension name and version.
4. Install the matching native host and verify its manifest still allowlists the stable extension ID.
5. Start a fresh OMP process and run Firefox Manual QA test cases 1, 2, and 4.
6. Confirm the fallback path still works by temporarily making the native host unavailable.
7. Record the AMO URL, visible version, Firefox version, OMP version, native-host version, and PASS/FAIL/BLOCKED results.

## Rollback

If the published add-on is defective:

1. Disable or unpublish the affected AMO version according to AMO’s current controls.
2. Restore the last known-good native host and OMP plugin versions.
3. Open a corrective issue and release a higher Firefox version; do not reuse the published version number.
4. Repeat linting, fresh-profile installation, and the manual QA flow before republishing.
