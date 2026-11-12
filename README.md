<div align="center">

# 🌿 Super Nature — Shopify Dawn Theme

### A modern, high-performance Shopify theme for natural, organic & eco-friendly stores

Built on Shopify's [Dawn](https://github.com/Shopify/dawn) (Online Store 2.0) foundation and supercharged with custom sections, smooth scroll animations, and a clean nature-inspired design.

[![Shopify](https://img.shields.io/badge/Shopify-Online%20Store%202.0-96bf48?logo=shopify&logoColor=white)](https://www.shopify.com/)
[![Liquid](https://img.shields.io/badge/Liquid-Templating-5A67D8)](https://shopify.github.io/liquid/)
[![Dawn](https://img.shields.io/badge/Based%20on-Dawn%20v15-000000?logo=shopify&logoColor=white)](https://github.com/Shopify/dawn)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

[Features](#-features) · [Demo](#-demo) · [Installation](#-installation) · [Customization](#-customization) · [Tech Stack](#-tech-stack)

</div>

---

## ✨ Overview

**Super Nature** is a fully responsive, conversion-focused Shopify theme designed for brands selling **natural, organic, herbal, wellness, and eco-friendly products**. It keeps Dawn's fast, HTML-first, server-rendered core while layering in a set of hand-built custom sections and tasteful animations that give your storefront a premium, modern feel — all editable directly from the Shopify Theme Editor with no code required.

> 💡 Perfect for cosmetics, skincare, supplements, food & beverage, plant shops, and any brand with a natural / sustainable story to tell.

## 🎯 Features

- 🧩 **Custom drag-and-drop sections** — Hero, Feature highlights, Shop Now, Social Media, About Us, Coming Soon, Contact form, and a bespoke Single Product layout
- ⚡ **Online Store 2.0 ready** — JSON templates, section groups, and app blocks fully supported
- 🎞️ **Smooth scroll animations** — lightweight vanilla JS reveals that respect reduced motion
- 📱 **Fully responsive** — mobile-first layout that looks great on every screen
- 🌍 **Multi-language ready** — 30+ locale files included out of the box
- 🛒 **Complete storefront** — product, collection, cart, blog, search, 404, password, and full customer account templates
- 🔤 **Premium typography** — bundled Aptos & Gill Sans Nova web fonts
- 🎨 **Theme Editor friendly** — colors, fonts, logos, and content configurable without touching code
- 🔒 **Password / Coming Soon page** — launch-ready pre-store mode

## 🖼️ Demo

> _Add a live preview link and screenshots here to boost engagement._

| Homepage | Product Page | Mobile |
|----------|-------------|--------|
| _screenshot_ | _screenshot_ | _screenshot_ |

🔗 **Live demo:** `https://your-store.myshopify.com`

## 🚀 Installation

### Option 1 — Shopify CLI (recommended for developers)

```bash
# 1. Install the Shopify CLI
npm install -g @shopify/cli @shopify/theme

# 2. Clone this repository
git clone https://github.com/topshopifydev/Shopify-Dawn-Theme.git
cd Shopify-Dawn-Theme

# 3. Connect to your store and start a live-reload dev server
shopify theme dev --store your-store.myshopify.com
```

### Option 2 — Upload to Shopify Admin

1. Download this repository as a **ZIP**.
2. In your Shopify Admin, go to **Online Store → Themes → Add theme → Upload zip file**.
3. Click **Customize** to open the Theme Editor and make it your own.

## 🎨 Customization

Everything is configurable from **Online Store → Themes → Customize**:

- **Sections** — add, remove, and reorder sections on any page via the Theme Editor
- **Colors & Typography** — set your brand palette and fonts under *Theme settings*
- **Logo & Favicon** — upload from *Theme settings → Logo*
- **Content** — edit hero headlines, feature blocks, and CTAs inline

Developers can extend the theme by editing the `.liquid` files in `sections/`, `snippets/`, and `assets/`.

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Platform | Shopify (Online Store 2.0) |
| Templating | Liquid |
| Base theme | Shopify Dawn v15 |
| Styling | CSS3; `assets/theme.css` holds a generated subset of Bootstrap 5 CSS (`tests/helpers/bootstrap-subset.cjs`) |
| Scripting | Vanilla JS (no jQuery or Bootstrap JS) |
| Icons | Inline SVG (`snippets/theme-icon.liquid`) |

## 📂 Project Structure

```
├── assets/        # CSS, JS, fonts, images, icons
├── config/        # Theme settings & schema
├── layout/        # theme.liquid & password.liquid
├── locales/       # 30+ translation files
├── sections/      # Custom & Dawn sections (hero, feature, shop-now…)
├── snippets/      # Reusable Liquid partials
└── templates/     # JSON templates for every page type
```

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to open an [issue](../../issues) or submit a pull request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is released under the **MIT License** — see [LICENSE.md](LICENSE.md) for details. Built upon Shopify Dawn, which is licensed under the MIT License by Shopify Inc.

## ⭐ Support

If this theme helped you, please consider giving it a **star** ⭐ — it helps others discover the project and keeps development going!

---

<div align="center">

**Made with 🌿 for natural & sustainable brands**

Built on [Shopify Dawn](https://github.com/Shopify/dawn) · Customized as *Super Nature*

</div>
