## Purpose

Keeps the rule "the user's accent is the only accent" true when shadcn components and a utility CSS build are present. Defines the single stylesheet, how shadcn tokens map onto Obsidian variables, and the gate that enforces it.

## ADDED Requirements

### Requirement: Single scoped stylesheet
The plugin SHALL ship one `styles.css`. Every selector SHALL sit under the view root class or begin with the chosen prefix. The stylesheet SHALL contain no `:root` or `body` rule.

#### Scenario: Stray global rule
- **WHEN** a build output contains a rule that is not under the root class or prefix
- **THEN** `check:styles` exits non-zero naming file, line and rule

### Requirement: Obsidian variables only
Colour, font and radius values SHALL come from Obsidian CSS variables. The stylesheet SHALL contain no hex or rgb literal, no gradient, no `@font-face`, and no `font-family` other than an Obsidian variable. It SHALL NOT redefine an Obsidian variable.

#### Scenario: Literal colour
- **WHEN** a hex literal appears anywhere in the built stylesheet
- **THEN** the gate fails

### Requirement: shadcn token map
shadcn tokens SHALL be defined only on the root class and each value SHALL be a `var()` of an allowed Obsidian variable. The shadcn `accent` token SHALL map to a hover surface and SHALL NOT map to the user's accent. Only `primary` and links MAY resolve to the user's accent. shadcn's default palette and dark block SHALL NOT be imported.

#### Scenario: Non-default accent
- **WHEN** the active theme sets a different accent colour
- **THEN** every accent-hued computed colour in the view traces to `--interactive-accent` or `--text-accent`, and no other hue appears except status colours from the Obsidian error, success and warning variables

### Requirement: Contrast of accent fills
Small text on an accent fill SHALL meet 4.5:1 on the default light and dark themes, or the control SHALL be an icon button or use a large label or an outline or ghost variant. The ratios SHALL be measured from computed styles at the phase gate; this spec asserts no ratio.

#### Scenario: Default light theme
- **WHEN** a text button is rendered on the default light theme
- **THEN** its measured contrast is recorded and is at least 4.5:1, or the button is not accent-filled

### Requirement: minAppVersion honesty
The stylesheet SHALL NOT use `color-mix` while `manifest.json` `minAppVersion` is below the Obsidian version that supports it, as established by the operator.

#### Scenario: color-mix present
- **WHEN** `color-mix` appears and `minAppVersion` has not been raised
- **THEN** the gate fails

### Requirement: Motion and touch
Expand SHALL take 200 ms and collapse 140 ms with ease-out. One rule SHALL honour `prefers-reduced-motion`. Interactive targets on mobile SHALL be at least 44 px; the AA floor is 24 px.

#### Scenario: Reduced motion
- **WHEN** the system requests reduced motion
- **THEN** expand and collapse transitions do not animate
