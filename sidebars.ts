import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    'getting-started',
    'how-it-works',
    'faq',
    {
      type: 'category',
      label: 'Depositors',
      items: [
        'depositors/deposit-guide',
        'depositors/withdraw-guide',
        'depositors/understanding-yield',
        'depositors/risks',
      ],
    },
    {
      type: 'category',
      label: 'Operators',
      items: [
        'operators/setup',
        'operators/docker',
        'operators/configuration',
        'operators/strategies',
        'operators/staking',
        'operators/troubleshooting',
      ],
    },
    {
      type: 'category',
      label: 'Developers',
      items: [
        'developers/architecture',
        {
          type: 'category',
          label: 'Contracts',
          items: [
            'developers/contracts/keeper-registry',
            'developers/contracts/nectar-vault',
          ],
        },
        'developers/keeper-sdk',
        'developers/adapter-guide',
        'developers/blend-integration',
        'developers/contributing',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        'reference/contract-addresses',
        'reference/error-codes',
        'reference/glossary',
      ],
    },
  ],
};

export default sidebars;
