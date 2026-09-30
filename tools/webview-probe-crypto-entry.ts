// Entry for the WebView probe of src/crypto (mvp-06). The whole public surface is referenced through a
// namespace object so nothing is tree-shaken away and the reported size is the real cost of the module.
import * as cryptoModule from "../src/crypto";

Object.assign(globalThis, { __ipfsSyncCryptoProbe: cryptoModule });
