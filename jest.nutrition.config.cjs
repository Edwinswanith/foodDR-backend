module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/*.test.cjs'],
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  clearMocks: true,
};
