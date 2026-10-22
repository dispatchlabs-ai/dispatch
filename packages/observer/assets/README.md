# Application icon

`icon.svg` is the original vector source, licensed with this package. Its activity
line matches Observer's in-app mark. `icon.png` is a 1024-pixel rendering;
`icon.icns` contains macOS icon sizes from 16 through 1024 pixels.

To regenerate, render the SVG with `rsvg-convert` at each standard macOS iconset
size (16, 32, 128, 256, 512 and their 2× variants), then run
`iconutil -c icns <directory>.iconset -o icon.icns`. Render the 1024-pixel PNG
directly from the same SVG. No private source images or generated-photo assets
are used. Windows icon packaging remains unqualified.
