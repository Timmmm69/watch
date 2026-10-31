# Watch design system

Watch uses the supplied [Airbnb reference](DESIGN-airbnb.md), adapted to a
Telegram watch store. Product names, prices, purchase channels, permissions,
legal copy and API contracts retain their existing meaning.

## Visual direction

White canvas, near-black text, restrained coral actions, rounded controls and
photography as the main source of colour. Cards have no enclosing border or
resting shadow: their square photographs have 16px corners, with short text
below. Categories use neutral text and a black underline for selection. Links,
checkboxes and focus outlines are neutral; status colours convey real feedback.
No invented ratings, favourites, inventory badges or nonfunctional controls.

The source of truth for tokens and primitives is
`apps/web/src/app/globals.css`. Use semantic utilities in every screen,
including partner and administrative screens, instead of hardcoded dark colours.

| Role | Utility | Value |
| --- | --- | --- |
| Canvas / panels | `bg-canvas` / `bg-surface` | `#ffffff` |
| Secondary surface | `bg-surface-muted` | `#f7f7f7` |
| Primary text / links | `text-ink` / `text-link` | `#222222` |
| Supporting text | `text-muted` | `#717171` |
| Decorative dividers | `border-hairline` | `#dddddd` |
| Form borders | `border-control` | `#858585` |
| Primary action / Watch mark | `bg-primary` | `#ff385c` |
| Primary hover | `bg-primary-active` | `#e31c5f` |
| Errors | `text-danger` | `#c13515` |
| Success / warning | `text-success` / `text-warning` | `#217347` / `#855400` |

## Typography and accessibility adaptations

Self-hosted **Nunito Variable**, the open-source rounded alternative listed in
the reference, includes Cyrillic. Use weights **400 and 700** and normal tracking.
The TTF is served locally, without a runtime font request to Google.
[Source](https://github.com/google/fonts/tree/main/ofl/nunito) and the SIL Open
Font License are retained at `public/fonts/Nunito-OFL.txt`.
Airbnb's proprietary Cereal font and logo are not bundled.

- Page headings: 28px / 700; section headings: 22px / 700.
- Body: 16px / 400; card titles and prices: 14px / 700; metadata: 14px / 400.
- Input text: 16px to avoid mobile zoom. Search labels: 12px / 700.
- Primary text buttons: **19px / 700**. White on exact `#ff385c` has about
  3.22:1 contrast, sufficient for large bold text (at least 18.67px), not normal
  small text. The search action uses a white icon and an accessible hidden label.
- Secondary text `#717171` is for white backgrounds. Do not lower opacity on it.
- Control borders use a darker neutral than decorative hairlines.
- Fields: 12px corners; panels and photographs: 16px; modal sheets: 24px;
  buttons and search: 50px. Touch targets are at least 44px.
- Keyboard focus stays visible; dialogs use native focus containment and Escape.
  Reduced motion disables transitions and pulsing skeletons.

This reference is explicitly a light visual system. Watch stays white even when
the host prefers dark mode, so dark Telegram settings do not reintroduce the
previous charcoal theme. Future dark mode requires a separate designed palette.

## Components and layout

| Class | Use |
| --- | --- |
| `app-shell` | Safe-area-aware gutters and full viewport height |
| `app-panel` | White panel, subtle border, 24px padding (20px on phones) |
| `app-button` | Neutral outlined pill; `app-button-primary` for the main action |
| `app-input` | Rounded, readable field with visible border |
| `app-table-wrap` | Table with scrolling confined to its own container |
| `shop-search` | Floating search pill with field, filters and coral search circle |
| `shop-grid` / `shop-product` | Borderless image-led product catalog |
| `shop-category` | Underlined category selected through `aria-pressed` |
| `shop-modal` | Bottom sheet on phones, centered dialog on larger screens |
| `shop-detail-layout` | Gallery and purchase area side by side, stacked on phones |
| `earnings-balances` | Neutral balance group with tabular figures |

Storefront width is at most 1280px; desktop gutters are at least 24px and mobile
gutters 16px. The grid has four columns from 1200px, three from 768px, two from
360px and one below 360px. Gaps use the 4px scale. Header links wrap; categories
scroll horizontally. Photo-free products show an honest watch placeholder.
Existing mobile purchase bars retain their bottom safe-area padding.

## Verification

Run web typecheck/build, the existing storefront and checkout feedback suites,
and `airbnb-design.spec.ts` for responsive layout, dialog keyboard behavior,
light appearance under both host colour preferences and local font loading.
Review catalog, product, filter sheet, cart, checkout, partner and admin screens.
Backend/database suites require their documented disposable PostgreSQL setup.
