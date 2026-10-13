# Vendored jsbeeb

Copied by `scripts/update-jsbeeb.mjs` from https://github.com/mattgodbolt/jsbeeb

- jsbeeb 2.4.0, commit `819b5c0f87e94bcf00288a4a3340bb98c655a1df`
- pako 3.0.2 (node_modules/pako, MIT)

Only the 57 source files reachable from src/index.js are kept, plus public/roms.
Do not edit these files: change jsbeeb upstream, or wrap it in server/.
Bare imports seen: assert, fs, node:path, node:url, node:util, pako, path, sharp, url
