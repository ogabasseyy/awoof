import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

export default {
  input: 'src/index.js',
  output: {
    file: 'dist/awoof.js',
    format: 'umd',
    name: 'Awoof',
    sourcemap: true,
  },
  plugins: [
    resolve(),
    ...(process.env.BUILD === 'development' ? [] : [terser({ format: { comments: false } })]),
  ],
};
