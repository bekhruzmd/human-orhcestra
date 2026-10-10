# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Primary user: event host running live audience music sessions on a laptop Stage screen.
- Secondary participants: audience members joining from phones via QR to perform in sync.

## Product Purpose

Human Orchestra turns a room of phones into a synchronized, collaborative music performance. It enables fast join, immediate participation, and coherent shared output on a central Stage with minimal setup overhead.

## Positioning

A browser-native, multiplayer performance system where timing and musical coherence are enforced by a shared server transport and step-quantized scheduling, so non-musicians can still produce a coordinated live result.

## Operating Context

- Live demos, hackathons, classrooms, and event activations with 1 to many participants.
- One laptop drives Stage visuals/audio; phones join by scanning a QR code.
- Hosts may run locally with HTTPS tunnel (`npm run demo`) or in cloud fallback deployment.
- Sessions include free play, rhythm-game performances, freestyle composition, and optional sample/MIDI workflows.

## Capabilities and Constraints

- Shared server-owned transport (tempo/step timeline) drives synchronization across devices.
- Browser-only join flow must remain intact (no mandatory app install).
- Low setup time is mandatory for real-time event use.
- Overall UI components and product feel must prioritize a retro 16-color, 8-bit pixel-graphics direction.
- No paid APIs are part of the baseline operating model.
- Product must continue to respect copyright boundaries: no bundled copyrighted song data without rights; user-supplied material remains user responsibility.
- Recording/replay is a core product direction; performance capture should support deterministic playback.
- Platform decision confirmed as web now, with possible native apps later (future direction, not current scope).

## Brand Commitments

- Product name: Human Orchestra.
- Core promise: collaborative musical play that feels synchronized and understandable even to observers.
- Visual identity commitment: retro arcade-inspired 16-color/8-bit pixel aesthetics across interface components, motion language, and presentation tone.

## Evidence on Hand

- Technical and product behavior documented in [README.md](README.md).
- Verification history, constraints, and known risks documented in [audit.md](audit.md).
- Existing deployed web endpoint documented in repository materials.
- No externally verified user-study dataset is currently committed; avoid inventing testimonial or benchmark claims.

## Product Principles

- Time coherence over individual freedom: shared timing correctness is foundational.
- Fast on-ramp: users should become musically effective within seconds.
- Observable collaboration: the Stage must make contribution and synchronization legible.
- Graceful degradation: features should remain useful across variable networks/devices.
- Strong thematic coherence: the retro pixel-art visual world is a product-level requirement, not optional decoration.
- Truthful constraints: legal, technical, and evidence boundaries are explicit and preserved.

## Accessibility & Inclusion

- Experience should remain understandable with muted audio through synchronized visual cues.
- Keep interaction pathways viable for first-time users and mixed-skill participants.
- Respect device variability (network, sensors, and browser capability differences) in core flows.
