import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        ignores: ['admin/**', 'test/**', 'node_modules/**', 'docs/**'],
    },
];
