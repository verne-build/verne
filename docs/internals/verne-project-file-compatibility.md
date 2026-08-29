# Verne project file compatibility

Verne supports both `verne.json` and the upstream-compatible `t3.json` as checked-in project
configuration files at a workspace root. Both filenames use the existing `T3ProjectFile` contract;
the alias changes discovery and product copy, not the configuration shape.

## Precedence

Project configuration is selected as one complete file:

1. Use `verne.json` when it exists.
2. Otherwise use `t3.json` when it exists.
3. Otherwise treat the project configuration as missing.

The files are never merged. A present `verne.json` is authoritative even when it is unreadable or
invalid. In that case consumers report or retain the existing invalid-file state and do not silently
fall back to `t3.json`. This makes configuration mistakes visible and keeps precedence predictable.

## Contract and schema

Both files decode through the existing `T3ProjectFile` schema and lenient JSON parser. A
`verne.json` file may continue to reference `https://t3.codes/schema/t3.json` in `$schema`; Verne does
not duplicate the schema or introduce a second schema-hosting dependency while the formats are
identical.

Shared filename constants define the ordered candidates so server, web, and mobile do not encode
precedence independently. Selection must preserve three outcomes: missing, present and valid, and
present but invalid. The selected filename travels with the decoded result where UI copy needs to
identify its source.

## Consumers

The compatibility resolver applies to every current project-file consumer:

- server project-file loading, including project favicon discovery;
- web project-script import and default thread environment selection;
- mobile default thread environment selection;
- user-facing source labels and invalid-file messaging.

Project-level settings continue to override checked-in values where they do today. For example, a
saved project favicon path still wins before the selected project file's `iconPath`.

## Failure behavior

- A missing candidate advances to the next filename.
- A read error for a present authoritative file is logged and blocks fallback.
- A decode error for a present authoritative file is logged and blocks fallback.
- If neither file exists, consumers preserve their current default behavior.

Client implementations may issue reads for both candidates concurrently, but selection always
follows precedence rather than response order. No contract or persistence migration is required
because existing project-file reads already carry filenames and contents.

## Verification

Focused coverage must prove:

- `verne.json` wins when both files are valid;
- valid `t3.json` is used when `verne.json` is absent;
- invalid or unreadable `verne.json` blocks a valid `t3.json` fallback;
- missing files preserve current defaults;
- favicon, scripts, and thread-environment consumers use the same selected file;
- web and mobile show the selected filename in source-specific copy.

The repository's own `t3.json` remains in place as a backward-compatibility example. Its `iconPath`
should point to `assets/verne/dev/verne-web-apple-touch-180.png` so project and thread cards use the
current Verne development icon.
