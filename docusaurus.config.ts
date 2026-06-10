import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Nectar Network',
  tagline: 'Pooled Liquidation Protocol for Soroban DeFi',
  favicon: 'img/favicon.svg',

  future: {
    v4: true,
  },

  url: 'https://docs.nectarnetwork.fun',
  baseUrl: '/',

  organizationName: 'Nectar-Network',
  projectName: 'docs-site',

  onBrokenLinks: 'throw',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  // Brand typefaces — Syne (display) + DM Mono (mono), matching the app.
  headTags: [
    {
      tagName: 'link',
      attributes: {rel: 'preconnect', href: 'https://fonts.googleapis.com'},
    },
    {
      tagName: 'link',
      attributes: {rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: 'anonymous'},
    },
  ],
  stylesheets: [
    'https://fonts.googleapis.com/css2?family=Syne:wght@500;600;700;800&family=DM+Mono:wght@300;400;500&display=swap',
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/Nectar-Network/docs-site/tree/docs-site/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/social-card.svg',
    metadata: [
      {name: 'description', content: 'Documentation for Nectar Network — a pooled liquidation protocol for Soroban DeFi on Stellar.'},
      {name: 'theme-color', content: '#0d0e12'},
    ],
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Nectar Network',
      logo: {
        alt: 'Nectar Network',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          position: 'left',
          label: 'Docs',
        },
        {
          href: 'https://nectarnetwork.fun',
          label: 'App',
          position: 'right',
        },
        {
          href: 'https://github.com/Nectar-Network/keeper-sdk',
          label: 'Keeper SDK',
          position: 'right',
        },
        {
          href: 'https://github.com/Nectar-Network/nectar',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Documentation',
          items: [
            {label: 'Getting Started', to: '/docs/getting-started'},
            {label: 'Depositor Guide', to: '/docs/depositors/deposit-guide'},
            {label: 'Operator Setup', to: '/docs/operators/setup'},
            {label: 'Architecture', to: '/docs/developers/architecture'},
          ],
        },
        {
          title: 'Build',
          items: [
            {label: 'Keeper SDK', href: 'https://github.com/Nectar-Network/keeper-sdk'},
            {label: 'Write an Adapter', to: '/docs/developers/adapter-guide'},
            {label: 'Contract Addresses', to: '/docs/reference/contract-addresses'},
            {label: 'Contributing', to: '/docs/developers/contributing'},
          ],
        },
        {
          title: 'Network',
          items: [
            {label: 'App', href: 'https://nectarnetwork.fun'},
            {label: 'GitHub', href: 'https://github.com/Nectar-Network'},
            {label: 'Twitter', href: 'https://x.com/nectar_xlm'},
            {label: 'Blend Protocol', href: 'https://blend.capital'},
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} Nectar Network · 29projects Lab · Built on Stellar · MIT License`,
    },
    prism: {
      theme: prismThemes.vsLight,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'toml', 'go', 'rust', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
