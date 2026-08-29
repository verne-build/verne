# Brand icons

The three Icon Composer projects are the source of truth for full application icons:

- `verne/dev/app-icon.icon`
- `verne/nightly/app-icon.icon`
- `verne/prod/app-icon.icon`

The Verne projects use the two symbol halves from Verne's Icon Composer source. Development,
nightly, and production currently contain identical artwork, but remain separate so each channel can
gain a distinct icon without changing build or packaging configuration.

Run `vp run icons:export` from the repository root to regenerate the tracked iOS, Linux, Windows, and web assets. The development web exports are also copied to `apps/web/public` for the browser favicon and splash screen. Run `vp run icons:check` to verify that the generated assets and public copies match their sources without changing files.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS exports

Icon Composer's command-line exporter does not expose the `macOS pre-Tahoe` preset. A plain command-line `macOS` export is full bleed and is not suitable for the desktop app, so the export script intentionally leaves the tracked macOS PNGs unchanged and prints a reminder after every run.

After changing an Icon Composer project, open it in Icon Composer and export the macOS PNG with exactly these settings:

- Platform: `macOS pre-Tahoe`
- Appearance: `Default`
- Size: `1024pt`
- Scale: `1×`

Save the three exports to:

- `verne/dev/app-icon.icon` -> `verne/dev/verne-macos-1024.png`
- `verne/nightly/app-icon.icon` -> `verne/nightly/verne-macos-1024.png`
- `verne/prod/app-icon.icon` -> `verne/prod/verne-macos-1024.png`

The result must be a 1024×1024 PNG with the classic macOS safe area: the opaque icon body is 824×824, inset 100 pixels on every side, with only the native Icon Composer shadow extending into the surrounding transparent canvas.

To have Codex perform the native exports, paste this prompt into a task opened at the repository root:

```text
Use [@Computer](plugin://computer-use@openai-bundled) and the Icon Composer app to export the three macOS app icons in this repository.

For each project below, use Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, and Scale: 1×, then save the PNG to the exact destination:

- assets/verne/dev/app-icon.icon -> assets/verne/dev/verne-macos-1024.png
- assets/verne/nightly/app-icon.icon -> assets/verne/nightly/verne-macos-1024.png
- assets/verne/prod/app-icon.icon -> assets/verne/prod/verne-macos-1024.png

Do not resize, composite, or otherwise post-process the exported PNGs.

Verify every result is 1024×1024 and has the classic macOS safe area: an 824×824 opaque body inset 100px on every side, with only Icon Composer's native shadow extending beyond it.
```

Do not edit the generated PNG or ICO files directly.

## Android adaptive foreground

`apps/mobile/assets/android-icon-foreground.svg` is the source of truth for the foreground used by
the normal Android adaptive launcher icon. Export its paired PNG after changing it:

```sh
rsvg-convert -w 432 -h 432 \
  -o apps/mobile/assets/android-icon-foreground.png \
  apps/mobile/assets/android-icon-foreground.svg
```

The foreground must remain transparent and keep the T3 mark inside Android's adaptive-icon safe
zone. `android-icon-mark.png` remains a flat silhouette for Android's monochrome themed icon.
