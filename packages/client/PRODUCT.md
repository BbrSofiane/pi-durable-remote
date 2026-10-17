# Product

## Register

product

## Users

The operator uses a local keyboard-driven terminal to work with a coding agent running on one remote VM. The VM owns tools, credentials and committed state; the client is a thin presentation and control surface.

## Product Purpose

Observe committed agent progress and send deliberate user intent. Preserve work across client disconnects, and make uncertain submission outcomes recoverable without accidental duplicate inputs.

## Brand Personality

Plain, direct, honest, and easy to scan. Use native pi-tui components with Pi-like semantic accents, clear role/tool hierarchy, readable Markdown and balanced spacing. Inherit the terminal's background and body foreground; avoid decorative cards, neon and gratuitous animation.

## Anti-references

Do not turn this focused terminal client into a web/device platform or introduce decorative controls, local repository previews, or opaque automatic command replay. A new request ID must never be disguised as recovery of an old input.

## Design Principles

- The remote committed view is authoritative; disconnected views are explicitly stale.
- Durable admission and answer completion are different outcomes.
- Recovery is a deliberate action tied to the original immutable input and persisted conversation identity.
- The current slice keeps receipts in memory only; closing the client loses them.
- Reuse existing keyboard/editor/transcript behavior and add only the controls needed for this failure path.

## Accessibility & Inclusion

Keep keyboard operation, explicit textual connection/error/recovery states, Unicode and narrow-terminal support, and terminal-control sanitization. Do not rely on color alone to communicate status. Keep primary prose at normal inherited foreground, with restrained terminal-palette accents for roles, focus and status. Keep light/dark terminal palettes and NO_COLOR legible through explicit labels and spacing, and preserve terminal restoration behavior. No browser or mouse interaction is required.
