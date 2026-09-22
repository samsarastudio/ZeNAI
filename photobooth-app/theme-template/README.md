# PhotoBooth theme (WordPress-style)

This folder is a **starter theme** you can duplicate, edit, zip, and upload from **Admin → Themes**.

## Structure

```
your-theme/
  theme.json      ← required metadata
  styles.css      ← optional: CSS overrides for :root --pb-* variables and .pb-* classes
  assets/         ← optional images, fonts (reference with relative URLs in CSS)
```

## theme.json

```json
{
  "id": "mybrand",
  "name": "My Brand",
  "version": "1.0.0",
  "author": "You",
  "description": "Short blurb for the admin picker."
}
```

- **id** must be lowercase letters, numbers, and hyphens only (used as folder name).

## styles.css

Override design tokens on `:root` (see bundled `themes/default/styles.css` for the full list), for example:

```css
:root {
  --pb-brand-accent: #2271b1;
  --pb-ink: #1d2327;
}
```

The booth UI uses BEM-like classes prefixed with `pb-` (e.g. `.pb-card`, `.pb-btn-primary`). You can override those like WordPress `style.css` overrides a parent theme.

## Zip & upload

1. Zip **the inner folder** (the folder that contains `theme.json`), not your Desktop parent folder.
2. In the app: **Admin → Themes → Upload theme (.zip)**.

## Download a fresh copy

Use **Admin → Themes → Download theme template (.zip)** to save this structure as a new zip from the kiosk PC.
