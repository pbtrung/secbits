let nextId = 6;
export const getNextId = () => nextId++;

export const sampleUser = { name: 'Trung Nguyen' };

export const sampleEntries = [
  {
    id: 1,
    title: 'GitHub',
    username: 'trung@github.com',
    password: 'gh-sup3r-s3cret!',
    urls: ['https://github.com', 'https://github.com/settings'],
    hiddenFields: [
      { id: 1, label: 'TOTP Secret', value: 'JBSWY3DPEHPK3PXP' },
    ],
    notes: 'Main dev account.\nBackup codes stored in safe.',
    tags: ['dev', 'work'],
  },
  {
    id: 2,
    title: 'Gmail',
    username: 'trung.nguyen@gmail.com',
    password: 'gm@il-Pa$$w0rd',
    urls: ['https://mail.google.com'],
    hiddenFields: [
      { id: 1, label: 'Recovery Key', value: 'ABCD-EFGH-IJKL-MNOP' },
    ],
    notes: 'Personal email account.',
    tags: ['email', 'personal'],
  },
  {
    id: 3,
    title: 'AWS Console',
    username: 'trung-admin',
    password: 'Aws!Pr0d#Key99',
    urls: ['https://console.aws.amazon.com', 'https://us-east-1.console.aws.amazon.com'],
    hiddenFields: [
      { id: 1, label: 'Access Key ID', value: 'AKIAIOSFODNN7EXAMPLE' },
      { id: 2, label: 'Secret Access Key', value: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    ],
    notes: 'Production AWS account.\nMFA enabled.',
    tags: ['work', 'cloud'],
  },
  {
    id: 4,
    title: 'Netflix',
    username: 'trung@gmail.com',
    password: 'netfl1x-ch1ll!',
    urls: ['https://netflix.com'],
    hiddenFields: [],
    notes: 'Family plan.',
    tags: ['personal', 'entertainment'],
  },
  {
    id: 5,
    title: 'Company VPN',
    username: 'tnguyen',
    password: 'Vpn$ecure2024!',
    urls: ['https://vpn.company.com'],
    hiddenFields: [
      { id: 1, label: 'TOTP Secret', value: 'HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ' },
      { id: 2, label: 'PIN', value: '8842' },
    ],
    notes: 'Use Cisco AnyConnect.\nContact IT if locked out: it-help@company.com',
    tags: ['work', 'vpn'],
  },
];
