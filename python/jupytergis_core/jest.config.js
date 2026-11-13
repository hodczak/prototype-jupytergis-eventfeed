module.exports = {
  ...require('../../packages/jest.base'),
  testEnvironment: 'jsdom',
  modulePathIgnorePatterns: [
    '<rootDir>/jupytergis_core/labextension/',
    '<rootDir>/lib/',
  ],
};
