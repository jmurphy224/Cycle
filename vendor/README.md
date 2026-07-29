# vendor/

Third-party browser libraries, vendored (not npm-installed) since this app
has no build step — everything is served as static files.

## zxing.min.js

`@zxing/library` v0.21.3 (MIT license), UMD build, unmodified.
Decodes barcodes (UPC/EAN) from live camera video in the browser — used by
the "Scan a barcode" feature on the Food tab, since Safari/WebKit doesn't
implement the native `BarcodeDetector` API that Chrome/Android support.

To update: `npm view @zxing/library version` for the latest release, then
`npm pack @zxing/library@<version>` and copy `umd/index.min.js` from the
extracted tarball to `vendor/zxing.min.js`.
