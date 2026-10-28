# Watch design system

The product uses a Notion-inspired visual language, adapted from the supplied
`DESIGN-notion.md`. This is a Watch theme, not an official Notion component kit.
The existing Next.js, Tailwind 4 and React stack remains the foundation.

## Direction

Warm paper canvas, white surfaces, near-black type and one blue action color.
Information architecture, navigation labels, legal content and workflows remain
the product's own. Marketing illustrations and an inverted hero are not required
for commerce forms, financial screens or administrative tools.

Taste settings: DESIGN_VARIANCE 4, MOTION_INTENSITY 2, VISUAL_DENSITY 5.
The taste skill's marketing-only rules do not govern product tables or forms.

## Tokens

The single source of truth is `apps/web/src/app/globals.css`. Use semantic
utilities rather than hardcoded slate shades or individual hex colors.

| Role | Utility | Light value |
| --- | --- | --- |
| Page background | `bg-canvas` | `#f6f5f4` |
| Panels and fields | `bg-surface` | `#ffffff` |
| Media and secondary surfaces | `bg-surface-muted` | `#efeeec` |
| Primary text | `text-ink` | `#20201e` |
| Secondary text | `text-ink-secondary` | `#31302e` |
| Supporting text and placeholders | `text-muted` | `#615d59` |
| Dividers | `border-hairline` | `#e6e6e6` |
| Form and utility-button borders | `border-control` | `#918b84` |
| Primary action | `bg-primary` | `#0075de` |
| Pressed primary | `bg-primary-active` | `#005bab` |
| Text on a primary action | `text-on-primary` | `#ffffff` |
| Inline links | `text-link` | `#005bab` |
| Success, warning, error | `text-success`, `text-warning`, `text-danger` | Dedicated accessible colors |

Blue is reserved for actions, links, selection and focus. Link blue is darker
than the reference's primary blue to maintain contrast on paper backgrounds.
The reference's faint ash is darkened for control borders (3.37:1 on white)
and is not used for small text. White text on primary blue has 4.57:1 contrast.
Semantic status colors supplement the reference because operational screens
need readable success, warning and error states. Destructive actions use a pale
red surface and red text instead of competing with the primary blue fill.

Dark mode follows `prefers-color-scheme`, swapping the same semantic variables
to warm charcoal surfaces and lighter text. No page mixes light and dark panels.

## Typography and shape

Self-hosted Inter Variable supports Cyrillic, weights 100-900 and optical sizing.
The font and its SIL Open Font License live in `apps/web/public/fonts/`.
Source: [Inter](https://rsms.me/inter/).

- Page titles: responsive 28-40px, weight 700, tight tracking and 1.15 line height.
- Watch wordmark and authentication title: 28px.
- Body: 15px with 1.5 line height. Form controls: 16px to avoid mobile input zoom.
- Financial numbers: tabular numerals. Balance figures: responsive 24-32px.
- Panels and product cards: 12px corners. Utility buttons: 8px. Fields: 4px.
- Category selectors: pills. Pill shapes do not extend to form fields.
- Spacing: 4px increments, generally 16-24px within groups and 24-40px between groups.

## Shared primitives

| Class | Purpose |
| --- | --- |
| `app-shell` | Responsive page gutters, 100dvh height and bottom safe-area inset |
| `app-panel` | White/charcoal panel, hairline border, 24px desktop / 20px mobile padding |
| `app-button` | Neutral 44px utility action with hover, press, focus and disabled states |
| `app-button app-button-primary` | Blue action with explicit white text |
| `app-input` | Bordered field with consistent typography and padding |
| `app-table-wrap` | Bordered table container with local horizontal scrolling |
| `shop-product` | Product card with a quiet border and restrained elevation |
| `shop-category` | Category pill with an `aria-pressed` selection state |
| `earnings-balances` | Readable financial balance group with tabular numbers |

Keep labels above fields and errors alongside the relevant input. All focus
targets receive a visible outline. Only feedback transitions are added; reduced
motion disables transitions and existing pulsing loaders. Product photography
comes from catalog media; missing images retain an honest neutral placeholder.

## Responsive behavior

- Below 640px: 16px page gutters, one-column product grid, full-width search
  field followed by two equal action buttons, and a scrollable filter sheet.
- From 640px: two-column products; filters open in a centered panel.
- From 1024px: three-column products within the existing content container.
- Navigation wraps when needed. Wide tables scroll within their own containers.
- Forms, tables and financial values keep their content and existing semantics.

## Review checklist

Check light and dark themes at desktop and mobile widths, primary-button and
form contrast, visible keyboard focus, disabled controls, selected categories,
loading/empty/error states, table scrolling and the filter sheet. Confirm local
Inter loads and pages do not gain horizontal overflow. Use existing Playwright
workflow tests to check that visual changes preserve product behavior.
