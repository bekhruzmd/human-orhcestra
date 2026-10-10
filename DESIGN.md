---
name: Human Orchestra
description: Browser-based collaborative music performance UI with retro 16-color arcade direction.
colors:
  bg-night: "#07070d"
  bg-player: "#0b0b12"
  panel-deep: "#12121c"
  panel-mid: "#16161f"
  text-main: "#f4f4fb"
  text-dim: "#8b8ba3"
  accent-cyan: "#35d0ff"
  accent-lime: "#7cff6b"
  accent-gold: "#ffd23f"
  accent-red: "#ff4d6d"
  accent-orange: "#ff9248"
  accent-violet: "#b388ff"
  accent-teal: "#2dffc4"
  accent-pink: "#ff6bd6"
  line-soft: "rgba(255,255,255,.12)"
typography:
  display:
    fontFamily: "ui-rounded, SF Pro Rounded, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(2.2rem, 6vw, 3.4rem)"
    fontWeight: 900
    lineHeight: 1
    letterSpacing: "0.04em"
  headline:
    fontFamily: "ui-rounded, SF Pro Rounded, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(1.4rem, 3vw, 2rem)"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "0.02em"
  title:
    fontFamily: "ui-rounded, SF Pro Rounded, system-ui, -apple-system, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 800
    lineHeight: 1.25
    letterSpacing: "0.04em"
  body:
    fontFamily: "ui-rounded, SF Pro Rounded, system-ui, -apple-system, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 700
    lineHeight: 1.45
  label:
    fontFamily: "ui-rounded, SF Pro Rounded, system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "0.16em"
rounded:
  xs: "8px"
  sm: "10px"
  md: "14px"
  lg: "18px"
  xl: "22px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-base:
    backgroundColor: "{colors.panel-deep}"
    textColor: "{colors.text-main}"
    rounded: "{rounded.md}"
    padding: "11px 9px"
  button-primary:
    backgroundColor: "{colors.accent-cyan}"
    textColor: "{colors.bg-night}"
    rounded: "{rounded.md}"
    padding: "14px 20px"
  panel-card:
    backgroundColor: "{colors.panel-deep}"
    textColor: "{colors.text-main}"
    rounded: "{rounded.xl}"
    padding: "24px"
  chip:
    backgroundColor: "{colors.panel-mid}"
    textColor: "{colors.text-main}"
    rounded: "{rounded.pill}"
    padding: "10px 14px"
---

# Design System: Human Orchestra

## Overview

**Creative North Star: "Neon Arcade Control Deck"**

Human Orchestra uses high-contrast dark canvases and luminous accent signals to make timing, participation, and musical state instantly legible at a distance. The incumbent visual language is rounded, energetic, and performance-first: information is presented as readable clusters (HUD, roster, controls) with strong color coding for status and role.

A product-level direction change now applies: the system should evolve toward a retro 16-color/8-bit pixel-graphics world while preserving the current product truths (synchronized clarity, fast on-ramp, and observer legibility). This means future UI work should favor pixel-grid motifs, blocky/iconic forms, finite palette discipline, and arcade-era feedback tone, rather than soft contemporary gradients as the dominant signature.

**Key Characteristics:**
- Dark stage with high-luminance accent signaling.
- One-glance readability for multiplayer state.
- Strong mode visibility (free play, game, sample, recording).
- Transition target: cohesive retro pixel/arcade identity using a constrained 16-color palette.

## Colors

The palette is currently neon-on-night with explicit status coding, and should be normalized into a disciplined 16-color retro set over time.

### Primary
- **Arcade Cyan** (#35d0ff): primary action and activation state for controls, progress accents, and mode emphasis.

### Secondary
- **Signal Lime** (#7cff6b): positive/live success and active game framing.

### Tertiary
- **Cabinet Gold** (#ffd23f): highlight/warning/feature emphasis (QR context, dialogs, sample tooling).

### Neutral
- **CRT Black** (#07070d): stage base canvas.
- **Console Black** (#0b0b12): player base canvas.
- **Panel Deep** (#12121c): primary panel surfaces.
- **Panel Mid** (#16161f): secondary panel surfaces.
- **Phosphor White** (#f4f4fb): main foreground text.
- **Dim Violet Gray** (#8b8ba3): secondary metadata text.
- **Soft Scanline Line** (rgba(255,255,255,.12)): separators and subtle border structure.

### Named Rules
**The 16-Color Discipline Rule.** New UI surfaces and component updates should stay within a named 16-color palette and avoid unconstrained one-off hues.

## Typography

**Display Font:** ui-rounded, SF Pro Rounded, system-ui, -apple-system, sans-serif
**Body Font:** ui-rounded, SF Pro Rounded, system-ui, -apple-system, sans-serif
**Label/Mono Font:** ui-rounded labels + ui-monospace for debug/stat dumps

**Character:** Heavy rounded weights prioritize readability on dynamic performance screens. The retro shift should preserve readability first, then introduce arcade-era typographic flavor through constrained uppercase labels, pixel-like spacing rhythm, and blockier heading treatment.

### Hierarchy
- **Display** (900, clamp(2.2rem, 6vw, 3.4rem), 1): critical in-view status and grade moments.
- **Headline** (800, clamp(1.4rem, 3vw, 2rem), 1.15): major section titles and song/game overlays.
- **Title** (800, 1.125rem, 1.25): cards, roster rows, and control group headings.
- **Body** (700, 0.95rem, 1.45): explanatory and operational text.
- **Label** (800, 0.75rem, 1.2, 0.16em): telemetry labels, chips, and compact metadata.

### Named Rules
**The Distance-Read Rule.** Every primary state label must remain readable from several feet away on a projected Stage.

## Layout

The app uses a fixed-screen orchestration layout with three stable regions: top HUD, right-side roster/QR rail, and bottom conductor controls. Stage content and gameplay visualization occupy the center field with explicit reserved margins. Player screens use full-height single-column layouts with large touch targets, bottom-safe-area treatment, and modal sheets for role/song utilities.

Spacing rhythm is compact and operational (4/8/12/16/24px) with larger radii and pill shapes for controls. Responsive behavior prioritizes maintaining control density and readability over decorative spacing expansion.

## Elevation & Depth

Depth is primarily conveyed through tonal layering, accent borders, and glow rather than heavy physical shadow stacks. Motion and emphasis are achieved through high-contrast state toggles and selective neon bloom.

### Shadow Vocabulary
- **Accent Glow:** `0 0 12px` to `0 0 60px` with accent colors for active beats, grades, and focal calls.
- **Action Bubble Lift:** `0 8px 40px #ff4d6d88` for the pre-audio unlock CTA.

### Named Rules
**The Flat-Until-Active Rule.** Resting surfaces should remain mostly tonal/flat; glow and lift are reserved for interaction, timing, or milestone states.

## Shapes

Current forms use rounded rectangles and pills (8px to 24px, plus pill/circle patterns) to support touch ergonomics and fast scan grouping. As retro styling is introduced, the shape language should shift toward chunkier, pixel-informed edge treatment where feasible, while keeping touch target quality and visual hierarchy intact.

## Components

### Buttons
- **Shape:** mostly medium rounded rectangles (14px) with high-weight uppercase-ish tone for action clarity.
- **Primary:** neon-accent fills with dark text for strong call-to-action contrast.
- **Hover / Focus:** border-brightening and color-state shifts; active states may scale slightly or pulse.
- **Variant families:** neutral panel buttons, drop/play gradients, mode-toggled outlines, recording-highlight variants.

### Chips
- **Style:** pill chips with accent-tinted background blends and strong border signal.
- **State:** on/off toggles are expressed via border and fill changes, never text-only deltas.

### Cards / Containers
- **Corner Style:** large rounded cards (18px to 24px).
- **Background:** deep panel tones over dark canvas.
- **Border:** accent-coded outlines for context (game/sample/song workflows).
- **Internal Padding:** medium to large (16px to 24px) for scanability.

### Inputs / Fields
- **Style:** high-contrast dark fields with visible border framing and large text for names/settings.
- **Focus:** color-forward border emphasis and unambiguous active context.
- **Error / Disabled:** opacity reductions and status-color semantics.

### Navigation
- **Style:** overlay sheets and modal boxes are the dominant navigation mechanism on phone and Stage utilities.
- **State treatment:** active mode buttons visibly lock state through fill/border shifts and icon+label pairings.

### Signature Component
- **Multiplayer Roster Rows:** left accent bar plus compact status telemetry and role iconography optimized for at-a-glance reading.

## Do's and Don'ts

### Do:
- **Do** preserve status-color semantics (ok/warn/bad and mode-specific accents) when introducing retro pixel treatment.
- **Do** keep interactive controls large and contrast-heavy for fast event-floor use.
- **Do** evolve toward a strict named 16-color palette and pixel-informed icon/ornament style.
- **Do** keep synchronization-critical information legible without audio.

### Don't:
- **Don't** introduce soft, low-contrast pastel themes that reduce stage readability.
- **Don't** add unconstrained gradients/noise that fight the 16-color arcade direction.
- **Don't** hide mode/state changes behind subtle transitions only; each mode change must be visually explicit.
- **Don't** sacrifice touch ergonomics for decorative retro styling.
