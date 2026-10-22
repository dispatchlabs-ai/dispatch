# Bundled license sources

`@earendil-works/chord` 1.3.0 declares MIT in its npm manifest but omits the
license file from that archive. [chord-1.3.0.txt](chord-1.3.0.txt) preserves the
[upstream v1.3.0 license](https://github.com/earendil-works/pi/blob/v1.3.0/LICENSE).
Recheck the source when changing that dependency.

The build collects other runtime licenses from installed packages, combines them
with Vite's renderer notices and Inter's OFL, and writes
`dist/THIRD-PARTY-NOTICES.md`. Electron retains its own notices in packaged apps.
