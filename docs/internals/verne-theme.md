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

Add a dual-mode, built-in theme with the identifier `verne`. Register it through the shared `ThemeDefinition` and `BUILT_IN_THEMES` path used by the existing themes. Dark remains the palette definition's base appearance for compatibility with stored `verne` preferences. At the product boundary, Verne replaces the stock T3 Code palette: System, Light, and Dark select the corresponding Verne half, and a fresh installation starts in System appearance. The mobile client may expose the shared palette, but its separate T3 Code default is unchanged.

New installations select the standard System preference, backed by Verne. Existing `system`, `light`, `dark`, and `verne` preferences all resolve through Verne, while other saved themes remain unchanged. The theme library presents Verne as its standard card and keeps the stored `verne` identifier readable without showing a duplicate card.

The pre-React boot script must know the Verne palette and default so the splash screen and browser chrome use the correct colors before hydration. Runtime theme selection must continue to set `data-theme-id="verne"` on the document root.

## Palette mapping

Use shadcn's default neutral palette as the shared light/dark foundation. Map its roles into T3 Code's existing semantic theme contract instead of introducing a second color system. T3-only status roles retain their semantic hues, while product surfaces follow the shadcn neutral hierarchy.

| T3 role family           | Light                       | Dark                        |
| ------------------------ | --------------------------- | --------------------------- |
| Canvas                   | `oklch(1 0 0)`              | `oklch(0.145 0 0)`          |
| Cards and popovers       | `oklch(1 0 0)`              | `oklch(0.205 0 0)`          |
| Sidebar                  | `oklch(0.985 0 0)`          | `oklch(0.205 0 0)`          |
| Hover and muted surfaces | `oklch(0.97 0 0)`           | `oklch(0.269 0 0)`          |
| Borders                  | `oklch(0.922 0 0)`          | `oklch(1 0 0 / 0.1)`        |
| Inputs                   | `oklch(0.922 0 0)`          | `oklch(1 0 0 / 0.15)`       |
| Primary text             | `oklch(0.145 0 0)`          | `oklch(0.985 0 0)`          |
| Muted text               | `oklch(0.556 0 0)`          | `oklch(0.708 0 0)`          |
| Primary controls         | `oklch(0.205 0 0)`          | `oklch(0.922 0 0)`          |
| Destructive              | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` |

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
- Sidebar metadata color and thread-title scale, through stable row data attributes.
- Existing focus rings, disabled states, touch targets, and accessibility contrast.

Prefer custom-property overrides. Use selectors based on existing `data-slot` and named surface attributes only when a component hard-codes a material that tokens cannot reach. Do not copy or fork React primitives.

## Syntax highlighting

The palette contract may carry VS Code-compatible TextMate token rules separately from UI colors.
Verne's dark variant retains the syntax rules from the original Verne editor theme. Imported VS
Code themes preserve `tokenColors`, including paired light/dark variants, and the web and desktop
clients register the active rules with the shared Shiki highlighter for chat code blocks and
project-content search results. Themes without syntax rules continue to use Pierre's default light
or dark syntax palette. React Native remains outside this web/desktop highlighting seam.

## Component boundaries

Feature components remain unchanged unless inspection proves that neither a semantic token nor a stable root attribute can express a required surface. If that occurs, add one stable styling hook to the upstream-shaped component and keep the visual rule in `verne-theme.css`.

The first pass covers shared primitives and the main working surfaces:

- Application canvas, sidebar, top bar, and resizable panel boundaries.
- Buttons, inputs, cards, menus, popovers, dialogs, tooltips, and toggles.
- Chat composer, user messages, markdown code blocks, and terminal drawer.
- Settings surfaces so users can switch away from Verne without losing access to the theme controls.

`apps/web/src/components/sidebar/SidebarChrome.tsx` is the narrow product-chrome seam for the
fork. Verne omits the upstream sidebar wordmark and keeps the environment-identification badge at
the right edge of the header, leaving the updater in its upstream footer position. The modern
sidebar's fixed controls are a second localized seam: Verne keeps the upstream thread-search
markup and logic dormant for mergeability, hides its control, and expands New thread to a labeled
full-width row. The legacy sidebar remains unchanged. Do not fork the shared sidebar primitive.

## Upstream maintenance

The fork should concentrate its persistent diff in these areas:

- One built-in palette definition and export.
- The default preference in the boot and runtime theme paths.
- One imported Verne stylesheet.
- Localized sidebar chrome and modern control-row adjustments, with the legacy sidebar unchanged.
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
