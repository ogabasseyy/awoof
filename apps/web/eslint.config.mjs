import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';
import reactHooks from 'eslint-plugin-react-hooks';

const eslintConfig = [
  ...nextVitals,
  ...nextTypeScript,
  {
    // The installed v7 plugin provides both rules; without this
    // registration the rule names below break `npm run lint` (and the
    // CI lint gate) with "could not find plugin".
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Existing client data-loading effects require a staged React Compiler
      // migration. Keep them visible without blocking the security upgrade.
      'react-hooks/immutability': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
    ],
  },
];

export default eslintConfig;
