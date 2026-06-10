import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Nectar Network',
  tagline: 'Pooled Liquidation Protocol for Soroban DeFi',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  url: 'https://docs.nectarnetwork.fun',
  baseUrl: '/',

  organizationName: 'Nectar-Network',
  projectName: 'docs-site',

  onBrokenLinks: 'warn',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/Nectar-Network/docs-site/tree/main/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/social-card.png',
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Nectar Network',
      logo: {
        alt: 'Nectar Logo',
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
          href: 'https://github.com/Nectar-Network/nectar-poc',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Getting Started', to: '/docs/getting-started'},
            {label: 'Depositor Guide', to: '/docs/depositors/deposit-guide'},
            {label: 'Operator Guide', to: '/docs/operators/setup'},
          ],
        },
        {
          title: 'Community',
          items: [
            {label: 'Discord', href: 'https://discord.gg/stellar'},
            {label: 'GitHub', href: 'https://github.com/Nectar-Network'},
          ],
        },
        {
          title: 'Links',
          items: [
            {label: 'App', href: 'https://nectarnetwork.fun'},
            {label: 'Stellar Expert', href: 'https://stellar.expert'},
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} 29projects Lab. MIT License.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'toml', 'go', 'rust', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
