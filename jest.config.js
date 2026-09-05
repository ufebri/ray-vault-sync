module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/tests/__mocks__/obsidian.ts',
  },
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
};
