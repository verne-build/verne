# Verne theme for the web and desktop clients

## Goal

Give T3 Code's shared React client the material language used by Verne Electron while keeping the fork easy to update from `pingdotgg/t3code`.

The work covers the browser client and the Electron desktop client, which wraps the same React UI. It does not cover the React Native mobile client or change T3 Code's layouts and interactions.

## Constraints

- Keep feature components aligned with upstream.
- Express the treatment through the existing theme contract, CSS custom properties, and stable `data-slot` attributes.
- Apply Verne-specific geometry and materials only while the Verne theme is active.
- Keep every existing T3 theme selectable and visually unchanged.
- Respect T3 Code's performance rules. The theme must not add continuous animation or expensive repaint effects.

## Theme registration and default selection

Add a dark, built-in theme with the identifier `verne`. Register it through the shared `ThemeDefinition` and `BUILT_IN_THEMES` path used by the existing themes. The mobile client may expose the shared palette, but this pass adds no mobile-specific component styling.

New installations select `verne` when no stored theme preference exists. Existing installations keep their saved preference. Users can switch to any stock or custom theme in Settings.

The pre-React boot script must know the Verne palette and default so the splash screen and browser chrome use the correct colors before hydration. Runtime theme selection must continue to set `data-theme-id="verne"` on the document root.

## Palette mapping

Use Verne Electron's default Sovngarde UI palette as the source. Map its roles into T3 Code's existing semantic theme contract instead of introducing a second color system.

| T3 role family                       | Verne source                 | Default value |
| ------------------------------------ | ---------------------------- | ------------- |
| Canvas, chrome, toolbar              | `background`, `editor-bg`    | `#0d1016`     |
| Cards, popovers, sidebar             | `card`, `popover`, `sidebar` | `#16191f`     |
| Hover and accent surfaces            | `accent`, `tab-border`       | `#1d2026`     |
| Borders, inputs, focus-neutral rings | `border`, `input`, `ring`    | `#2e3138`     |
| Primary control surface              | `primary`                    | `#3a3d41`     |
| Secondary control surface            | `secondary`                  | `#3a4150`     |
| Primary text                         | `foreground`                 | `#f2fffc`     |
| Muted text                           | `muted-foreground`           | `#6b7678`     |
| Soft secondary text                  | `soft-foreground`            | `#bfbdb7`     |
| Destructive                          | `destructive`                | `#ff6d7e`     |

T3-only status, message, terminal, and provider roles should derive from the nearest Verne role while preserving readable contrast and existing semantic meaning.

## Scoped material layer

Keep Verne-specific geometry and material rules in `apps/web/src/verne-theme.css`. Import that file once from the web stylesheet entry point. Scope every selector under `html[data-theme-id="verne"]`.

The stylesheet owns:

- Base radius `0.625rem` and the derived radius scale.
- Compact control radius and matching nested radii.
- One-pixel neutral borders on cards, panels, menus, dialogs, inputs, and separators.
- Verne's solid dark surfaces and restrained `shadow-xs` depth.
- The translucent floating-surface recipe for menus, tooltips, and overlays where T3 already uses glass.
- Sidebar, top bar, composer, message, code-block, and terminal surface relationships.
- Existing focus rings, disabled states, touch targets, and accessibility contrast.

Prefer custom-property overrides. Use selectors based on existing `data-slot` and named surface attributes only when a component hard-codes a material that tokens cannot reach. Do not copy or fork React primitives.

## Component boundaries

Feature components remain unchanged unless inspection proves that neither a semantic token nor a stable root attribute can express a required surface. If that occurs, add one stable styling hook to the upstream-shaped component and keep the visual rule in `verne-theme.css`.

The first pass covers shared primitives and the main working surfaces:

- Application canvas, sidebar, top bar, and resizable panel boundaries.
- Buttons, inputs, cards, menus, popovers, dialogs, tooltips, and toggles.
- Chat composer, user messages, markdown code blocks, and terminal drawer.
- Settings surfaces so users can switch away from Verne without losing access to the theme controls.

## Upstream maintenance

The fork should concentrate its persistent diff in these areas:

- One built-in palette definition and export.
- The default preference in the boot and runtime theme paths.
- One imported Verne stylesheet.
- Focused registration, boot, and palette tests.

Upstream feature components should merge without theme-specific edits. When upstream adds a primitive or surface, it inherits the semantic palette first. Add a scoped selector only if the inherited result does not match the Verne material language.

## Verification

Add focused tests that prove:

- The Verne theme is registered and resolves as dark.
- A fresh client selects Verne by default.
- A stored user preference wins over the default.
- Boot-time and runtime palette values agree.
- Other built-in themes retain their definitions.

Run targeted web theme tests, web type checking, and linting for changed files. Then inspect the main chat, settings, menus, dialogs, and terminal surfaces in the retained isolated dev environment at common desktop widths. Capture before-and-after images if the work becomes a pull request.
