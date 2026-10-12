// @ts-check
// Note: type annotations allow type checking and IDEs autocompletion

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'IPFS Sync for Obsidian',
  tagline: 'Sync your vault over IPFS through a kubo node you run or trust.',
  favicon: 'img/favicon.ico',

  // Parameterized for GitHub Pages (donor pattern): defaults target the
  // project Pages URL; a custom domain later is env + CNAME only.
  url: process.env.SITE_URL || 'https://prometheus-ags.github.io',
  baseUrl: process.env.BASE_URL || '/obsidian-ipfs-sync/',

  organizationName: 'Prometheus-AGS',
  projectName: 'obsidian-ipfs-sync',

  onBrokenLinks: 'throw',

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  themes: [
    '@docusaurus/theme-mermaid',
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexDocs: true,
        indexPages: true,
        indexBlog: false,
        docsRouteBasePath: ['docs'],
      },
    ],
  ],

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          // Relative paths (not require.resolve): the config object is
          // serialized into the client bundle, and absolute paths would leak
          // the build machine's home directory into the published site.
          sidebarPath: './sidebars.js',
          editUrl: 'https://github.com/Prometheus-AGS/obsidian-ipfs-sync/edit/main/site/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      navbar: {
        title: 'IPFS Sync for Obsidian',
        logo: {
          alt: 'IPFS Sync for Obsidian home',
          src: 'img/knowme-conviction.svg',
          srcDark: 'img/knowme-conviction-dark.svg',
          width: 32,
          height: 32,
        },
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docsSidebar',
            position: 'left',
            label: 'Docs',
          },
          {
            href: 'https://github.com/Prometheus-AGS/obsidian-ipfs-sync',
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
              {
                label: 'Introduction',
                to: '/docs/intro',
              },
            ],
          },
          {
            title: 'More',
            items: [
              {
                label: 'GitHub',
                href: 'https://github.com/Prometheus-AGS/obsidian-ipfs-sync',
              },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Prometheus AGS. MIT License.`,
      },
      prism: {
        theme: require('prism-react-renderer').themes.github,
        darkTheme: require('prism-react-renderer').themes.dracula,
        additionalLanguages: ['rust', 'toml', 'bash'],
      },
    }),
};

module.exports = config;
