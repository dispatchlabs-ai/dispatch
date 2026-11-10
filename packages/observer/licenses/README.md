# Bundled license sources

`@earendil-works/chord` 1.5.2 declares MIT in its npm manifest but omits the
license file from that archive. [chord-1.5.2.txt](chord-1.5.2.txt) preserves the
[upstream v1.5.2 license](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/LICENSE).
Recheck the source when changing that dependency.

The build collects other runtime licenses from installed packages, combines them
with Vite's renderer notices and Inter's OFL, and writes
`dist/THIRD-PARTY-NOTICES.md`. Electron retains its own notices in packaged apps.
