# Bundled license sources

`@earendil-works/chord` 1.4.0 declares MIT in its npm manifest but omits the
license file from that archive. [chord-1.4.0.txt](chord-1.4.0.txt) preserves the
[upstream v1.4.0 license](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/LICENSE).
Recheck the source when changing that dependency.

The build collects other runtime licenses from installed packages, combines them
with Vite's renderer notices and Inter's OFL, and writes
`dist/THIRD-PARTY-NOTICES.md`. Electron retains its own notices in packaged apps.
